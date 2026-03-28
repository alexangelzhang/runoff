export class MathProcessor {
  /**
   * Performs a complex synchronous calculation.
   * Goal for Agents: Refactor this to be async and add a simulated delay.
   */
  process(a: number, b: number): number {
    console.log("Processing synchronous math...");
    return (a * b) + (a / b);
  }
}
