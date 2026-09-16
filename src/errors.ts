export class HideoutError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "HideoutError";
    this.exitCode = exitCode;
  }
}
