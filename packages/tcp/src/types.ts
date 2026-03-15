/**
 * Duck-typed interfaces for clock and scheduler integration.
 * No hard dependency on @simnode/clock or @simnode/scheduler.
 */

/** Minimal virtual-clock interface. */
export interface IClock {
  now(): number;
  setTimeout(cb: (...args: unknown[]) => void, delay: number): number;
}

/** Minimal scheduler interface. */
export interface IScheduler {
  enqueueCompletion(op: { id: string; when: number; run: () => Promise<void> | void }): void;
}

/** A registered TCP mock handler. */
export interface TcpMockHandler {
  /**
   * Receives raw data written by the client.
   * Returns response buffer(s) to emit back, or null for no response.
   */
  (data: Buffer, socket: TcpMockContext): TcpHandlerResult | Promise<TcpHandlerResult>;
}

export interface TcpMockContext {
  /** Remote address this socket is connected to. */
  remoteHost: string;
  remotePort: number;
}

export type TcpHandlerResult =
  | Buffer
  | Buffer[]
  | null
  | void;

/** Configuration for a TCP mock endpoint. */
export interface TcpMockConfig {
  handler: TcpMockHandler;
  /** Virtual latency in ms per response (delivered via clock/scheduler). */
  latency?: number;
}

/** Thrown when a TCP connection is attempted without a registered mock. */
export class SimNodeUnmockedTCPConnectionError extends Error {
  constructor(host: string, port: number) {
    super(
      `SimNode: No TCP mock registered for ${host}:${port}. ` +
      `All outbound TCP connections must be mocked during simulation. ` +
      `Register a mock with: interceptor.mock("${host}:${port}", { handler })`,
    );
    this.name = 'SimNodeUnmockedTCPConnectionError';
  }
}
