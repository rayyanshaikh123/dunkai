import dns from 'node:dns';
import http from 'node:http';
import { app } from './app.js';
import { env } from './config/env.js';
import { connectDatabase } from './config/database.js';
import { initSocket } from './sockets/index.js';
import { reconcileStaleJobs } from './services/reconcile.service.js';
import { reconcilePendingPayments } from './services/stripe.service.js';

// Opt-in only. Forcing public resolvers fixed `mongodb+srv` lookups on one
// local network, but on a host it breaks every private name: docker-compose
// services (`mongo`, `ai-engine`) and Railway/Render internal hostnames.
if (env.dnsServers.length) dns.setServers(env.dnsServers);

const start = async () => {
  try {
    await connectDatabase();
    reconcileStaleJobs().catch((error) => console.error('Job reconciliation failed:', error));
    setInterval(() => reconcileStaleJobs().catch((error) => console.error('Job reconciliation failed:', error)), 5 * 60 * 1000).unref();
    if (env.billingEnabled && env.stripeSecretKey) {
      let checkingPayments = false;
      const recoverPayments = async () => {
        if (checkingPayments) return;
        checkingPayments = true;
        try {
          const result = await reconcilePendingPayments();
          if (result.errors.length) console.warn(`Payment reconciliation: ${result.errors.length} orders could not be confirmed; they will be retried`);
        } catch (error) { console.error('Payment reconciliation failed:', error.message); }
        finally { checkingPayments = false; }
      };
      recoverPayments();
      setInterval(recoverPayments, 5 * 60 * 1000).unref();
    }

    const server = http.createServer(app);

    // Initialize Socket.io
    const io = initSocket(server);
    app.set('io', io);
    if (env.localRuntimeEnabled) {
      const { reconcileRuntimeJobs } = await import('./services/runtime.service.js');
      setInterval(() => reconcileRuntimeJobs(io).catch((error) => console.error('Runtime recovery failed:', error.message)), 30_000).unref();
      await reconcileRuntimeJobs(io);
    }

    // Socket.io and the SSE relay hold connections open for minutes; keep the
    // HTTP server from closing idle keep-alive sockets under a proxy first.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;

    server.listen(env.port, '0.0.0.0', () => {
      console.info(`\n  Dunk AI Backend running on port ${env.port}`);
      console.info(`  Environment: ${env.nodeEnv}`);
      console.info(`  API docs: http://localhost:${env.port}/docs`);
      console.info(`  Health:   http://localhost:${env.port}/health\n`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.info('\n  SIGTERM received, shutting down gracefully...');
      server.close(() => {
        console.info('  Server closed');
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      console.info('\n  SIGINT received, shutting down gracefully...');
      server.close(() => {
        console.info('  Server closed');
        process.exit(0);
      });
    });
  } catch (error) {
    console.error('Startup failed:', error);
    process.exitCode = 1;
  }
};

start();
