# @simnode/pg-mock

PostgreSQL wire protocol v3 mock for SimNode. Supports startup handshake (no SSL), simple query protocol, RowDescription/DataRow/CommandComplete, BEGIN/COMMIT/ROLLBACK, and basic SQL patterns (SELECT/INSERT/UPDATE/DELETE with WHERE). Throws `SimNodeUnsupportedPGFeature` for unsupported features. Plugs into `@simnode/tcp` as a handler.
