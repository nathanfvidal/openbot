// Exercita a separação real com TeamStore durável, SQLite do produto e cadastro HTTP local.
// Usa somente conta e dados fictícios; nenhuma instância ou API de produção é acessada.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CentralAuthUser, ChannelMessage } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { ChannelStore } from "../src/backend/channel-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { AgentInitializationGate } from "../src/main/agent-initialization";
import { type ClonedHostIdentityOptions, ClonedHostIdentityService } from "../src/main/cloned-host-identity";
import { remoteCall } from "../src/main/remote-service-effects";
import {
  parseRequiredIdentitySeparation,
  ServerMode,
  type ServerModeOptions,
  takeServerModeEnvironment,
} from "../src/main/server-mode";
import { type ClonedIdentityInput, TeamStore } from "../src/main/team-store";

const out = resolve(".openbot-build/cloned-host-identity-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-identidade-e2e-"));
const owner: CentralAuthUser = {
  id: randomUUID(),
  email: "proprietario@example.invalid",
  name: "Proprietário de teste",
  avatarUrl: null,
};
const other: CentralAuthUser = {
  id: randomUUID(),
  email: "outro@example.invalid",
  name: "Outro usuário de teste",
  avatarUrl: null,
};
type Registration = { hostId: string; name: string; ownerMembershipId: string; devicePublicKey?: string | null };
type Mode = "normal" | "falha" | "resposta-perdida" | "confirmacao-errada" | "troca-conta" | "falha-gravacao";
const rows = new Map<string, Registration>();
const requests: Registration[] = [];
let mode: Mode = "normal";
let actor = owner;
let paused = 0;
let activated = 0;
let protectedDirectory: string | null = null;
const results: { caso: string; aprovado: boolean }[] = [];
const report = {
  aprovado: false,
  casos: results,
  naoVerificado: [
    "Registro e conexão WebRTC na conta de produção; este teste usa API HTTP local.",
    "Aplicação na Autus e rotação das credenciais de produção; nenhuma implantação realizada.",
  ],
};
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const input: Registration = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(req.url, "/register");
    requests.push(input);
    if (mode === "falha") {
      res.writeHead(503).end();
      return;
    }
    const previous = rows.get(input.hostId);
    if (previous) assert.deepEqual(input, previous, "A recuperação mudou o candidato registrado.");
    for (const [id, row] of rows) {
      if (id !== input.hostId)
        assert.notEqual(input.ownerMembershipId, row.ownerMembershipId, "Colisão de associação.");
    }
    rows.set(input.hostId, input);
    if (mode === "resposta-perdida") {
      res.destroy();
      return;
    }
    if (mode === "troca-conta") actor = other;
    if (mode === "falha-gravacao" && protectedDirectory) await chmod(protectedDirectory, 0o500);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        hostId: mode === "confirmacao-errada" ? randomUUID() : input.hostId,
        membershipId: input.ownerMembershipId,
        name: input.name,
        authEpoch: 1,
      }),
    );
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
const endpoint = `http://127.0.0.1:${address.port}/register`;
const register: ClonedHostIdentityOptions["registerRemoteHost"] = (input) =>
  remoteCall(async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5_000),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error("Cadastro de teste recusado.");
    return response.json();
  });
function service(store: TeamStore) {
  return new ClonedHostIdentityService({
    store,
    registerRemoteHost: register,
    getSignedInUser: () => actor,
    pauseHost: () =>
      Effect.sync(() => {
        paused += 1;
      }),
    identityActivated: () =>
      Effect.sync(() => {
        activated += 1;
      }),
  });
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function openStore(path: string) {
  const store = new TeamStore(path);
  await runCauseEffect(store.initialize());
  return store;
}
async function fixture(label: string) {
  actor = owner;
  mode = "normal";
  const source = join(root, label, "natek");
  const target = join(root, label, "autus");
  await mkdir(source, { recursive: true });
  const originalPath = join(source, "openbot-team-server-v2.json");
  const original = await openStore(originalPath);
  const identity = await runCauseEffect(original.configureWithAccount("Natek de teste", owner));
  const oldSession = await runCauseEffect(original.loginWithAccount(owner));
  await runCauseEffect(original.createInvite("member"));
  const db = new OpenBotDatabase(source);
  await runCauseEffect(db.initialize());
  const channels = new ChannelStore(db);
  const agentId = randomUUID(),
    channelId = randomUUID(),
    messageId = randomUUID();
  const attachmentId = randomUUID();
  const binary = randomBytes(8193);
  await mkdir(join(source, "anexos"), { recursive: true });
  await writeFile(join(source, "anexos", attachmentId), binary);
  const channel = channels.create(channelId, {
    name: "Studio de teste",
    title: "Canal preservado",
    instructions: "Instrução de teste preservada.",
    members: [{ agentId }],
    leadAgentId: agentId,
  });
  const message: ChannelMessage = {
    id: messageId,
    channelId,
    sequence: 1,
    author: { kind: "member", id: owner.id, name: "Proprietário de teste" },
    taskId: null,
    superseded: false,
    message: {
      id: messageId,
      author: "user",
      text: "Mensagem de teste preservada.",
      createdAt: new Date().toISOString(),
      status: "completed",
      attachments: [
        {
          id: attachmentId,
          name: "amostra.bin",
          size: binary.length,
          kind: "file",
          mimeType: "application/octet-stream",
          previewKind: "none",
          previewUrl: null,
        },
      ],
    },
  };
  channels.commit(randomUUID(), { channel, messages: [message], tasks: [], assignments: [] });
  db.close();
  await cp(source, target, { recursive: true });
  const targetPath = join(target, "openbot-team-server-v2.json");
  const store = await openStore(targetPath);
  const sourceBytes = await readFile(originalPath);
  const dbHash = digest(await readFile(join(target, "openbot.db")));
  const sourceId = identity.serverId;
  const stored = JSON.parse(sourceBytes.toString());
  const member = stored.hosts[0].members.find((value: { role: string }) => value.role === "owner");
  const row: Registration = {
    hostId: sourceId,
    name: identity.serverName,
    ownerMembershipId: member.id,
    devicePublicKey: identity.publicKey,
  };
  rows.set(sourceId, row);
  const remoteSession = store.openRemoteSession({
    sessionId: randomUUID(),
    membershipId: member.id,
    userId: owner.id,
    role: "owner",
  });
  const input: ClonedIdentityInput = {
    operationId: randomUUID(),
    expectedServerId: sourceId,
    expectedFingerprint: identity.fingerprint,
    serverName: "Autus de teste",
  };
  return {
    store,
    input,
    targetPath,
    target,
    sourceId,
    sourceBytes,
    row,
    oldSession,
    remoteSession,
    async check() {
      assert.deepEqual(await readFile(originalPath), sourceBytes, "A identidade Natek mudou.");
      assert.deepEqual(rows.get(sourceId), row, "O registro Natek mudou.");
      assert.equal(digest(await readFile(join(target, "openbot.db"))), dbHash, "O banco mudou.");
      assert.equal(digest(await readFile(join(target, "anexos", attachmentId))), digest(binary), "O binário mudou.");
      const reopened = new OpenBotDatabase(target);
      await runCauseEffect(reopened.initialize());
      try {
        const data = new ChannelStore(reopened);
        assert.equal(data.get(channelId).instructions, channel.instructions);
        assert.deepEqual(data.messages(channelId), [message]);
      } finally {
        reopened.close();
      }
      assert.equal((await stat(targetPath)).mode & 0o777, 0o600, "Permissão do diário inadequada.");
    },
  };
}
async function step(caso: string, run: () => Promise<void>) {
  await run();
  results.push({ caso, aprovado: true });
  // Saída legível do relatório, sem dados de autenticação.
  process.stdout.write(`Aprovado: ${caso}\n`);
}
try {
  await step("Prévia não grava nem registra; aplicação cria identidade distinta e preserva dados.", async () => {
    const f = await fixture("sucesso"),
      op = service(f.store);
    const before = await readFile(f.targetPath),
      calls = requests.length;
    const preview = await runCauseEffect(op.preview(f.input));
    assert.equal(preview.phase, "preview");
    assert.equal(preview.newServerId, null);
    assert.equal(preview.sessionsToRevoke, 2);
    assert.ok(f.store.authenticate(f.oldSession.sessionToken));
    assert.ok(f.store.authenticate(f.remoteSession.sessionToken));
    assert.equal(f.store.listInvites().length, 1);
    assert.deepEqual(await readFile(f.targetPath), before);
    assert.equal(requests.length, calls);
    const completed = await runCauseEffect(op.apply(f.input));
    assert.equal(completed.phase, "completed");
    assert.equal(f.store.authenticate(f.oldSession.sessionToken), null);
    assert.equal(f.store.authenticate(f.remoteSession.sessionToken), null);
    assert.equal(f.store.listInvites().length, 0);
    assert.equal(f.store.listSessions().length, 0);
    assert.equal(f.store.getMember(f.row.ownerMembershipId)?.disabled, true);
    assert.notEqual(f.store.getIdentity()?.serverId, f.sourceId);
    assert.notEqual(f.store.getIdentity()?.publicKey, f.row.devicePublicKey);
    const count = requests.length,
      id = f.store.getIdentity()?.serverId;
    const repeated = await runCauseEffect(op.apply(f.input));
    assert.equal(repeated.newServerId, id);
    assert.equal(requests.length, count, "A repetição recadastrou o servidor.");
    assert.equal(JSON.stringify(completed).includes("PRIVATE KEY"), false);
    const reloaded = await openStore(f.targetPath);
    assert.equal(reloaded.getIdentity()?.serverId, id);
    await f.check();
  });
  await step("Falhas de gravação antes e depois do cadastro mantêm recuperação durável.", async () => {
    const f = await fixture("disco-antes"),
      before = requests.length;
    await chmod(f.target, 0o500);
    try {
      await assert.rejects(() => runCauseEffect(service(f.store).apply(f.input)));
      assert.equal(requests.length, before);
      assert.equal(f.store.getIdentity()?.serverId, f.sourceId);
    } finally {
      await chmod(f.target, 0o700);
    }
    assert.equal((await runCauseEffect(service(f.store).preview(f.input))).phase, "preview");
    const g = await fixture("disco-depois");
    protectedDirectory = g.target;
    mode = "falha-gravacao";
    try {
      await assert.rejects(() => runCauseEffect(service(g.store).apply(g.input)));
      assert.equal(g.store.getIdentity()?.serverId, g.sourceId);
    } finally {
      await chmod(g.target, 0o700);
      protectedDirectory = null;
      mode = "normal";
    }
    const pending = await runCauseEffect(service(g.store).preview(g.input));
    const reloaded = await openStore(g.targetPath);
    await runCauseEffect(service(reloaded).recover(g.input));
    assert.equal(reloaded.getIdentity()?.serverId, pending.newServerId);
    await f.check();
    await g.check();
  });
  for (const failure of ["falha", "resposta-perdida", "confirmacao-errada", "troca-conta"] as const) {
    await step(`Recuperação após ${failure} reutiliza candidato e conserva a origem.`, async () => {
      const f = await fixture(failure);
      mode = failure;
      await assert.rejects(() => runCauseEffect(service(f.store).apply(f.input)));
      assert.equal(f.store.getIdentity()?.serverId, f.sourceId);
      actor = owner;
      mode = "normal";
      const pending = await runCauseEffect(service(f.store).preview(f.input));
      assert.equal(pending.phase, "pending");
      assert.ok(pending.newServerId);
      const reloaded = await openStore(f.targetPath);
      const recovered = await runCauseEffect(service(reloaded).recover(f.input));
      assert.equal(recovered.phase, "completed");
      assert.equal(reloaded.getIdentity()?.serverId, pending.newServerId);
      await f.check();
    });
  }
  await step("Proprietário, identidade e assinatura incorretos são recusados antes da rede.", async () => {
    const f = await fixture("guardas"),
      calls = requests.length,
      pauses = paused;
    actor = other;
    await assert.rejects(() => runCauseEffect(service(f.store).apply(f.input)));
    actor = owner;
    for (const invalid of [
      { ...f.input, expectedServerId: randomUUID() },
      { ...f.input, expectedFingerprint: "incorreta" },
    ]) {
      await assert.rejects(() => runCauseEffect(service(f.store).apply(invalid)));
    }
    await assert.rejects(() => runCauseEffect(service(f.store).recover(f.input)));
    assert.equal(requests.length, calls);
    assert.equal(paused, pauses);
    await f.check();
  });
  await step("Operação concorrente e rotação de chave pendente não criam identidades extras.", async () => {
    const f = await fixture("concorrencia");
    const op = service(f.store);
    const replies = await Promise.allSettled([runCauseEffect(op.apply(f.input)), runCauseEffect(op.apply(f.input))]);
    assert.equal(replies.filter((value) => value.status === "fulfilled").length, 1);
    const g = await fixture("rotacao");
    await runCauseEffect(g.store.beginKeyRotation());
    const count = requests.length;
    await assert.rejects(() => runCauseEffect(service(g.store).apply(g.input)));
    assert.equal(requests.length, count);
    await f.check();
    await g.check();
  });
  await step("A senha local legada não é herdada pelo novo proprietário.", async () => {
    actor = owner;
    mode = "normal";
    const dir = join(root, "legado");
    await mkdir(dir, { recursive: true });
    const store = await openStore(join(dir, "openbot-team-server-v2.json"));
    await runCauseEffect(store.configure("Legado de teste", "proprietario", "senha-ficticia-123456"));
    await runCauseEffect(store.activateAccount(owner));
    const before = store.getIdentity();
    assert.ok(before);
    const oldLogin = await runCauseEffect(store.login(owner.email, "senha-ficticia-123456"));
    assert.ok(store.authenticate(oldLogin.sessionToken));
    await runCauseEffect(
      service(store).apply({
        operationId: randomUUID(),
        expectedServerId: before.serverId,
        expectedFingerprint: before.fingerprint,
        serverName: "Autus de teste",
      }),
    );
    await assert.rejects(() => runCauseEffect(store.login(owner.email, "senha-ficticia-123456")));
    const accountLogin = await runCauseEffect(store.loginWithAccount(owner));
    assert.ok(store.authenticate(accountLogin.sessionToken));
    assert.equal(store.authenticate(oldLogin.sessionToken), null);
  });
  await step(
    "Trava de inicialização só libera a origem confirmada na conta ativa, inclusive após reinício.",
    async () => {
      const f = await fixture("inicializacao");
      assert.equal(f.store.isClonedIdentitySeparationCompletedFrom(f.sourceId), false);
      assert.equal(parseRequiredIdentitySeparation(f.sourceId), f.sourceId);
      assert.equal(parseRequiredIdentitySeparation(undefined), undefined);
      for (const invalid of ["", "incorreto", "29CB2428-F7D5-4D4E-9A45-6924F1A536DF"]) {
        assert.throws(() => parseRequiredIdentitySeparation(invalid));
      }
      const environment = takeServerModeEnvironment(
        {
          OPENBOT_SERVER: "1",
          XDG_RUNTIME_DIR: join(root, "runtime-env"),
          OPENBOT_REQUIRE_IDENTITY_SEPARATION: f.sourceId,
        },
        true,
        "linux",
      );
      assert.equal(environment?.requiredIdentitySeparationFrom, f.sourceId);
      mode = "falha";
      await assert.rejects(() => runCauseEffect(service(f.store).apply(f.input)));
      const pending = await openStore(f.targetPath);
      assert.equal(pending.isClonedIdentitySeparationCompletedFrom(f.sourceId), false);
      mode = "normal";
      await runCauseEffect(service(pending).recover(f.input));
      const completed = await openStore(f.targetPath);
      assert.equal(completed.isClonedIdentitySeparationCompletedFrom(f.sourceId), true);
      assert.equal(completed.isClonedIdentitySeparationCompletedFrom(randomUUID()), false);
      await runCauseEffect(completed.activateAccount(other));
      assert.equal(completed.isClonedIdentitySeparationCompletedFrom(f.sourceId), false);
      await runCauseEffect(completed.activateAccount(owner));
      assert.equal(completed.isClonedIdentitySeparationCompletedFrom(f.sourceId), true);
      await f.check();
    },
  );
  await step("Trabalho automático fica suspenso antes e depois da separação até liberação explícita.", async () => {
    const f = await fixture("trabalho-suspenso");
    const callbacks: string[] = [];
    const initialize = (rosterLoaded: Effect.Effect<void>) =>
      Effect.gen(function* () {
        callbacks.push("initialize");
        yield* rosterLoaded;
        for (const name of ["events", "automation", "routineFlow", "workflow", "routineResult"]) {
          callbacks.push(name);
        }
      });
    const suspended = () => new AgentInitializationGate(initialize, { suspended: true });
    for (const gate of [suspended(), suspended()]) {
      await runCauseEffect(gate.start());
      await runCauseEffect(gate.start());
      await runCauseEffect(gate.awaitRoster());
      await runCauseEffect(gate.awaitSettled());
      assert.equal(gate.pending, false);
      assert.equal(gate.succeeded, false);
    }
    assert.deepEqual(callbacks, []);
    mode = "normal";
    actor = owner;
    await runCauseEffect(service(f.store).apply(f.input));
    const reopened = await openStore(f.targetPath);
    assert.equal(reopened.isClonedIdentitySeparationCompletedFrom(f.sourceId), true);
    const restarted = suspended();
    await runCauseEffect(restarted.start());
    assert.equal(restarted.succeeded, false);
    assert.deepEqual(callbacks, [], "A separação retomou trabalho sem autorização.");
    const released = new AgentInitializationGate(initialize);
    await runCauseEffect(released.start());
    await runCauseEffect(released.start());
    await runCauseEffect(released.awaitRoster());
    await runCauseEffect(released.awaitSettled());
    assert.equal(released.pending, false);
    assert.equal(released.succeeded, true);
    assert.deepEqual(callbacks, ["initialize", "events", "automation", "routineFlow", "workflow", "routineResult"]);
    await f.check();
  });
  await step("Socket do produto executa prévia, aplicação, repetição e status sem expor credenciais.", async () => {
    const f = await fixture("socket"),
      op = service(f.store);
    const runtime = join(root, "runtime");
    await mkdir(runtime, { mode: 0o700 });
    const socket = join(runtime, "control.sock");
    const forbidden = (): never => {
      throw new Error("Operação fora do escopo do teste.");
    };
    const host: ServerModeOptions["host"] = {
      getStatus: () => ({
        phase: "idle",
        configured: true,
        enabledOnLaunch: false,
        serverId: f.store.getIdentity()?.serverId ?? null,
        serverName: f.store.getIdentity()?.serverName ?? null,
        logoUrl: null,
        apiUrl: null,
        apiOnline: false,
        remoteDesktopReady: false,
        remoteDesktopScreenRecordingDenied: false,
        remoteDesktopUnattended: false,
        remoteDesktopActiveSessions: 0,
        remoteDesktopMaxSessions: 4,
        message: null,
      }),
      configure: forbidden,
      start: forbidden,
      updateIdentity: forbidden,
      getMobileConnectHost: () => {
        const current = f.store.getIdentity();
        return current ? { hostId: current.serverId, fingerprint: current.fingerprint } : null;
      },
      previewClonedIdentity: (input) => op.preview(input),
      applyClonedIdentity: (input) => op.apply(input),
      recoverClonedIdentity: (input) => op.recover(input),
    };
    const local = new ServerMode({
      environment: { controlSocketPath: socket },
      version: "teste",
      host,
      memory: null,
      centralAuth: {
        getState: () => ({ status: "signed_in", user: actor }),
        requestEmailCode: forbidden,
        cancelCompanySignIn: forbidden,
        verifyEmailCode: forbidden,
        canPersistSession: () => true,
        redeemServerClaim: forbidden,
        logout: forbidden,
        createMobileConnect: forbidden,
      },
      onError: forbidden,
    });
    const body = new URLSearchParams({
      expected_server_id: f.input.expectedServerId,
      expected_fingerprint: f.input.expectedFingerprint,
      operation_id: f.input.operationId,
      name: f.input.serverName,
    }).toString();
    const call = (path: string, method = "POST") =>
      new Promise<{ status: number; text: string }>((done, reject) => {
        const req = request(
          { socketPath: socket, path, method, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
          (res) => {
            const parts: Buffer[] = [];
            res.on("data", (part) => parts.push(Buffer.from(part)));
            res.on("end", () => done({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString() }));
          },
        );
        req.on("error", reject);
        req.setTimeout(10_000, () => req.destroy(new Error("Prazo do socket excedido.")));
        req.end(method === "POST" ? body : undefined);
      });
    try {
      await runCauseEffect(local.listen());
      assert.equal((await stat(runtime)).mode & 0o777, 0o700);
      const preview = await call("/v1/identity/preview");
      assert.equal(preview.status, 200);
      assert.ok(preview.text.includes("phase=preview"));
      const applied = await call("/v1/identity/apply");
      assert.equal(applied.status, 200);
      assert.ok(applied.text.includes("phase=completed"));
      const calls = requests.length;
      assert.equal((await call("/v1/identity/recover")).status, 200);
      assert.equal(requests.length, calls);
      const status = await call("/v1/status", "GET");
      assert.equal(status.status, 200);
      assert.ok(status.text.includes(`server_id=${f.store.getIdentity()?.serverId}`));
      assert.ok(status.text.includes(`server_fingerprint=${f.store.getIdentity()?.fingerprint}`));
      actor = other;
      const denied = await call("/v1/identity/preview");
      assert.equal(denied.status, 409);
      assert.ok(denied.text.includes("identity_separation_failed"));
      for (const response of [preview, applied, status, denied]) {
        assert.equal(/PRIVATE KEY|sessionToken|privateKey|machineToken/.test(response.text), false);
      }
      actor = owner;
      await f.check();
    } finally {
      actor = owner;
      await runCauseEffect(local.close());
    }
  });
  assert.ok(paused > 0 && activated > 0);
  report.aprovado = true;
} finally {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  await rm(root, { recursive: true, force: true });
}
