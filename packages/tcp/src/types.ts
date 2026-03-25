/**
 * Duck-typed interfaces for clock and scheduler integration.
 * No hard dependency on @crashlab/clock or @crashlab/scheduler.
 */

/** Minimal virtual-clock interface. */
export interface IClock {
  now(): number;
  setTimeout(cb: (...args: unknown[]) => void, delay: number): number;
}

/** Minimal scheduler interface. */
export interface IScheduler {
  enqueueCompletion(op: { id: string; when: number; run: () => Promise<void> | void }): void;
  requestRunTick?(virtualTime: number): void;
  /**
   * When set, VirtualSocket._write uses this value instead of clock.now()
   * for computing `when` and the op ID.  The pump sets this to clock.now()
   * at pump-start so that late-arriving writes (Express processed during a
   * deliver() I/O yield) still land at the correct virtual time.
   */
  writeTimeOverride?: number;
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
  /** Unique socket identifier for per-connection state tracking. */
  socketId: number;
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

/** Thrown when a connection to an explicitly unsupported protocol port is attempted. */
export class SimNodeUnsupportedProtocolError extends Error {
  constructor(protocol: string) {
    super(
      `SimNode: ${protocol} is not supported in v1.0. ` +
      `Only PostgreSQL (5432), Redis (6379), and MongoDB (27017) are available.`,
    );
    this.name = 'SimNodeUnsupportedProtocolError';
  }
}
