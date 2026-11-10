// biome-ignore-all lint/nursery/noUnsafeTypeAssertion: fixtures parciais simulam serviços externos no limite público do ciclo.
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import type { AgentClient } from "../agent-client";
import type { AgentStore } from "../agent-store";
import type { UsageLimitContinuation } from "../mailbox-store";
import { TurnLifecycle, type TurnLifecycleOptions } from "./turn-lifecycle";
import { UsageLimitGate } from "./usage-limit-gate";

function fixture() {
  const snapshot = { threadId: "thread", activeTurnId: null, messages: [] as unknown[] };
  const item: {
    delivery: { id: string; sender: { kind: string }; recipientAgentId: string };
    resumeAfterUsageLimit?: UsageLimitContinuation;
  } = { delivery: { id: "delivery", sender: { kind: "user" }, recipientAgentId: "agent" } };
  let state = "starting";
  let stopped = false;
  let ready = true;
  const agent = { id: "agent", provider: "codex", model: "principal" };
  let onDrain = () => {};
  const gate = new UsageLimitGate({
    store: { list: () => [agent] } as unknown as AgentStore,
    hooks: {
      emit: () => {},
      emitRuntimeSnapshot: () => {},
      scheduleDrain: () => onDrain(),
      readUsage: () => Effect.succeed(null),
      held: () => Effect.void,
      released: () => Effect.void,
    },
  });
  const errors: unknown[][] = [];
  const noop = () => {};
  const effect = () => Effect.void;
  const hooks = {
    emit: noop,
    emitError: (...args: unknown[]) => errors.push(args),
    emitFailure: noop,
    emitRuntimeSnapshot: noop,
    emitToolUsage: noop,
    scheduleDrain: () => onDrain(),
    turnModel: () => agent.model,
    mayContinueOnBackup: () => ready,
    mayFailOver: () => ready,
    turnStopped: () => stopped,
    redactMcp: (s: string) => s,
    taskForThread: () => null,
    hasOpenWait: () => false,
    conversationTurnEnded: effect,
    closeRoutineSession: effect,
  };
  const options = {
    hooks,
    store: { list: () => [agent], database: { listProviderSessions: () => [] } },
    mailbox: {
      startingDeliveryForAgent: () => item,
      startingDeliveriesForAgent: () => [item],
      findDeliveriesByTurn: () => (state === "running" ? [item] : []),
      markTerminal: (_id: string, terminal: string) => {
        state = terminal;
        return Effect.void;
      },
      markRunning: () => {
        state = "running";
        return Effect.void;
      },
      requeueRefused: (_id: string, continuation: UsageLimitContinuation | undefined) => {
        state = "queued";
        item.resumeAfterUsageLimit = continuation;
        return Effect.void;
      },
    },
    mailboxSync: { emitQueue: noop, syncDeliveryMessage: noop },
    conversation: {
      agentForThread: () => "agent",
      publicThreadId: () => "thread",
      isRoutineSession: () => false,
      isTaskThread: () => false,
      isExecutionThread: () => false,
      ensureSnapshot: () => snapshot,
      emitConversation: noop,
      channelForThread: () => null,
    },
    providers: { refreshUsageAfterLimit: effect },
    memories: { finishTurn: () => new Map() },
    instructions: { finishTurn: () => Effect.succeed(null) },
    browser: { endControl: noop },
    attention: { clearForTurn: noop },
    compaction: {
      claimTurn: () => false,
      beginTurn: noop,
      threadTurnEnded: noop,
      isCompactionTurn: () => false,
      reserve: () => false,
    },
    images: { waitForOperations: effect, handleItem: () => Effect.succeed(true) },
    deltas: { flushTurn: noop },
    usageLimits: gate,
    planContinuation: { cancel: noop, limit: 0 },
  };
  const lifecycle = new TurnLifecycle(options as unknown as TurnLifecycleOptions);
  let provider: AgentClient["provider"] = "codex";
  const client = {
    get provider() {
      return provider;
    },
    contextCompaction: "none",
    readHistory: () => Effect.void,
  } as unknown as AgentClient;
  const notify = (
    method: string,
    params: {
      turnId?: string;
      message?: string;
      causeCode?: "usage_limit";
      error?: { codexErrorInfo: string };
      turn?: { id: string; status?: string };
      item?: { id: string; type: string; command: string };
    },
  ) => Effect.runPromise(lifecycle.handleNotification({ method, params: { threadId: "thread", ...params } }, client));
  return {
    setProvider: (value: AgentClient["provider"]) => {
      provider = value;
    },
    lifecycle,
    notify,
    errors,
    item,
    gate,
    agent,
    client,
    onDrain: (fn: () => void) => {
      onDrain = fn;
    },
    close: async () => {
      await Effect.runPromise(lifecycle.dispose());
      await Effect.runPromise(gate.dispose());
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    stop: () => {
      stopped = true;
      state = "cancelled";
    },
    state: () => state,
    start: async (id: string) => {
      state = "running";
      await notify("turn/started", { turn: { id } });
    },
  };
}

describe("retomada após cota", () => {
  test("preserva a entrega quando a última reserva recusa uma continuação", async () => {
    const f = fixture();
    f.item.resumeAfterUsageLimit = {
      turnId: "principal",
      previousTurnIds: ["principal"],
      workSteps: "ação já executada",
    };
    f.setReady(false);
    try {
      await f.start("reserva");
      await f.notify("error", {
        turnId: "reserva",
        message: "usage limit reached",
        error: { codexErrorInfo: "usageLimitExceeded" },
        causeCode: "usage_limit",
      });
      await f.notify("turn/completed", { turn: { id: "reserva", status: "failed" } });
      expect(f.errors).toEqual([]);
      expect(f.state()).toBe("queued");
      expect(f.item.resumeAfterUsageLimit?.workSteps).toContain("ação já executada");
    } finally {
      await f.close();
    }
  });
});

describe("limites e cancelamento da continuação", () => {
  test("cota genérica da reserva preserva os passos anteriores", async () => {
    const f = fixture();
    f.item.resumeAfterUsageLimit = { turnId: "principal", previousTurnIds: ["principal"], workSteps: "ação única" };
    f.setReady(false);
    try {
      await f.start("reserva");
      await f.notify("error", { turnId: "reserva", message: "quota exhausted", causeCode: "usage_limit" });
      await f.notify("turn/completed", { turn: { id: "reserva", status: "failed" } });
      expect(f.errors).toEqual([]);
      expect(f.state()).toBe("queued");
      expect(f.item.resumeAfterUsageLimit?.previousTurnIds).toEqual(["principal", "reserva"]);
      expect(f.item.resumeAfterUsageLimit?.workSteps).toContain("ação única");
      f.setReady(true);
      await f.start("renovado");
      expect(f.state()).toBe("running");
      expect(f.item.resumeAfterUsageLimit?.previousTurnIds).toEqual(["principal", "reserva"]);
    } finally {
      await f.close();
    }
  });
  test("Stop impede recolocar a entrega na fila", async () => {
    const f = fixture();
    f.item.resumeAfterUsageLimit = { turnId: "principal", previousTurnIds: ["principal"], workSteps: "ação única" };
    f.setReady(false);
    try {
      await f.start("reserva");
      await f.notify("error", { turnId: "reserva", message: "quota exhausted", causeCode: "usage_limit" });
      f.stop();
      await f.notify("turn/completed", { turn: { id: "reserva", status: "interrupted" } });
      expect(f.errors).toEqual([]);
      expect(f.state()).toBe("cancelled");
    } finally {
      await f.close();
    }
  });
});

test.each([false, true])("renovação da mesma entrega, cancelada durante a espera: %s", async (cancelled) => {
  const f = fixture();
  const originalNow = Date.now;
  const originalTimeout = globalThis.setTimeout;
  const timers: Array<() => void> = [];
  let now = originalNow();
  let actions = 0;
  let resumed = 0;
  let resume: Promise<void> | undefined;
  Date.now = () => now;
  globalThis.setTimeout = ((callback: () => void, delay: number | undefined, ...args: unknown[]) => {
    if ((delay ?? 0) >= 30_000) {
      timers.push(callback);
      return originalTimeout(() => {}, 1);
    }
    return originalTimeout(callback, delay, ...args);
  }) as unknown as typeof setTimeout;
  try {
    await f.start("principal");
    actions++;
    await f.notify("item/started", {
      turnId: "principal",
      item: { id: "ação", type: "commandExecution", command: "printf teste" },
    });
    await f.notify("error", {
      turnId: "principal",
      message: "usage limit reached",
      error: { codexErrorInfo: "usageLimitExceeded" },
      causeCode: "usage_limit",
    });
    await f.notify("turn/completed", { turn: { id: "principal", status: "failed" } });
    expect(f.state()).toBe("queued");
    f.agent.provider = "antigravity";
    f.agent.model = "reserva";
    f.setProvider("antigravity");
    f.setReady(false);
    await f.start("reserva");
    await f.notify("error", {
      turnId: "reserva",
      message: "You have exhausted your capacity on this model",
      causeCode: "usage_limit",
    });
    await f.notify("turn/completed", { turn: { id: "reserva", status: "failed" } });
    expect(f.state()).toBe("queued");
    expect(f.gate.mayDrain("agent")).toBe(false);
    expect(f.item.resumeAfterUsageLimit?.previousTurnIds).toEqual(["principal", "reserva"]);
    f.onDrain(() => {
      if (f.state() === "queued" && f.gate.mayDrain("agent")) {
        resumed++;
        resume = f.start("renovado");
      }
    });
    if (cancelled) f.stop();
    now += 20 * 60_000;
    for (const callback of [...timers]) callback();
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    await resume;
    if (cancelled) {
      expect(resumed).toBe(0);
      expect(f.state()).toBe("cancelled");
      expect(f.errors).toEqual([]);
      return;
    }
    expect(resumed).toBe(1);
    expect(actions).toBe(1);
    expect(f.state()).toBe("running");
    await f.notify("turn/completed", { turn: { id: "renovado", status: "completed" } });
    expect(f.state()).toBe("completed");
    expect(f.errors).toEqual([]);
  } finally {
    globalThis.setTimeout = originalTimeout;
    Date.now = originalNow;
    await f.close();
  }
});

test("saldo insuficiente não vira espera por renovação", async () => {
  const f = fixture();
  f.setReady(false);
  f.item.resumeAfterUsageLimit = { turnId: "principal", previousTurnIds: ["principal"], workSteps: "ação" };
  try {
    await f.start("reserva");
    await f.notify("error", { turnId: "reserva", message: "insufficient credits balance", causeCode: "usage_limit" });
    expect(f.gate.mayDrain("agent")).toBe(true);
  } finally {
    await f.close();
  }
});
