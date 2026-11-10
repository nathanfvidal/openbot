import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { RemoteWorkflowError, remoteDecode } from "./remote-service-effects";
import type { ClonedIdentityInput, ClonedIdentityPreview, TeamStore } from "./team-store";

export interface ClonedHostIdentityOptions {
  store: TeamStore;
  getSignedInUser: () => CentralAuthUser;
  registerRemoteHost: (input: {
    hostId: string;
    name: string;
    ownerMembershipId: string;
    devicePublicKey?: string | null;
  }) => Effect.Effect<unknown, RemoteWorkflowError>;
  /** O HostService drena cadastros e publicações anteriores antes de persistir o bloqueio. */
  prepareIdentity?: TeamStore["prepareClonedIdentity"];
  pauseHost: () => Effect.Effect<void, RemoteWorkflowError>;
  identityActivated: () => Effect.Effect<void, RemoteWorkflowError>;
}

/** Separa uma cópia sem remover, renomear ou registrar novamente a identidade original. */
export class ClonedHostIdentityService {
  readonly #options: ClonedHostIdentityOptions;
  #running = false;

  constructor(options: ClonedHostIdentityOptions) {
    this.#options = options;
  }

  readonly preview = Effect.fn("ClonedHostIdentity.preview")(function* (
    this: ClonedHostIdentityService,
    input: ClonedIdentityInput,
  ): Effect.fn.Return<ClonedIdentityPreview, RemoteWorkflowError> {
    return yield* remoteDecode(() => this.#options.store.previewClonedIdentity(this.#options.getSignedInUser(), input));
  }).bind(this);

  readonly apply = Effect.fn("ClonedHostIdentity.apply")(function* (
    this: ClonedHostIdentityService,
    input: ClonedIdentityInput,
  ): Effect.fn.Return<ClonedIdentityPreview, RemoteWorkflowError> {
    if (this.#running)
      return yield* new RemoteWorkflowError({ cause: new Error("Uma separação já está em execução.") });
    this.#running = true;
    return yield* Effect.gen({ self: this }, function* () {
      const { store } = this.#options;
      const user = yield* remoteDecode(() => this.#options.getSignedInUser());
      const candidate = yield* (this.#options.prepareIdentity ?? store.prepareClonedIdentity)(user, input);
      if (candidate.phase === "completed") {
        yield* this.#options.identityActivated();
        return yield* this.preview(input);
      }
      if (!candidate.newServerId)
        return yield* new RemoteWorkflowError({ cause: new Error("Candidato sem identificador.") });
      // O diário já impede publicações automáticas, inclusive depois de uma queda do processo.
      yield* this.#options.pauseHost();
      yield* this.preview(input);
      const result = yield* this.#options
        .registerRemoteHost({
          hostId: candidate.newServerId,
          name: candidate.serverName,
          ownerMembershipId: candidate.ownerMembershipId,
          devicePublicKey: candidate.publicKey,
        })
        .pipe(
          Effect.mapError(
            () =>
              new RemoteWorkflowError({
                cause: new Error(
                  "Cadastro central não confirmado. A identidade antiga está preservada e o acesso permanece pausado.",
                ),
              }),
          ),
        );
      // Resposta perdida ou não reconhecida nunca autoriza a ativação. A recuperação reutiliza o candidato.
      yield* remoteDecode(() => {
        if (
          !isDynamicRecord(result) ||
          result.hostId !== candidate.newServerId ||
          result.membershipId !== candidate.ownerMembershipId ||
          result.name !== candidate.serverName ||
          typeof result.authEpoch !== "number" ||
          !Number.isSafeInteger(result.authEpoch) ||
          result.authEpoch < 1
        )
          throw new Error(
            "Cadastro central não confirmado. A identidade antiga está preservada e o acesso permanece pausado.",
          );
        if (this.#options.getSignedInUser().id !== user.id) throw new Error("A conta mudou durante a separação.");
      });
      const completed = yield* store.completeClonedIdentity(user, input);
      yield* this.#options.identityActivated();
      return completed;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.#running = false;
        }),
      ),
    );
  }, Effect.uninterruptible).bind(this);

  readonly recover = Effect.fn("ClonedHostIdentity.recover")(function* (
    this: ClonedHostIdentityService,
    input: ClonedIdentityInput,
  ): Effect.fn.Return<ClonedIdentityPreview, RemoteWorkflowError> {
    const preview = yield* this.preview(input);
    if (preview.phase === "preview")
      return yield* new RemoteWorkflowError({ cause: new Error("Não existe operação pendente para recuperar.") });
    return yield* this.apply(input);
  }).bind(this);
}
