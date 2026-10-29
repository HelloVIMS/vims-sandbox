// Inert stand-ins for the Workers runtime base classes (unit tests only).
export class DurableObject<E = unknown> {
  constructor(public ctx: unknown, public env: E) {}
}
export class WorkerEntrypoint<E = unknown, P = unknown> {
  ctx!: { props: P };
  env!: E;
}
