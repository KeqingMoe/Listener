import type { FastifyInstance } from 'fastify';
import { type AuthStore, sessionToken } from './auth.ts';

export const authWrites = new Set(['/api/auth/login', '/api/auth/logout']);

export function registerAuthRoutes(app: FastifyInstance, auth: AuthStore) {
  app.get('/api/auth/session', async (req) => ({
    authenticated: auth.authenticated(sessionToken(req.headers.cookie)),
    configured: auth.configured,
    ...(!auth.configured &&
    auth.configurationError === 'password_invalid_configuration'
      ? { error: auth.configurationError }
      : {}),
  }));
  app.post('/api/auth/login', async (req, reply) => {
    const body = req.body as { password?: unknown } | null;
    const result = auth.login(body?.password, req.ip);
    if (
      result.status === 'password_not_configured' ||
      result.status === 'password_invalid_configuration'
    ) {
      return reply.code(503).send({
        error: result.status,
        message: 'Dashboard password configuration required',
      });
    }
    if (result.status !== 'ok') {
      return reply.code(result.status === 'limited' ? 429 : 401).send({
        error: result.status === 'limited' ? 'rate_limited' : 'unauthorized',
        message: 'Unable to sign in',
      });
    }
    return reply
      .header('Set-Cookie', auth.cookie(result.token))
      .send({ authenticated: true });
  });
  app.post('/api/auth/logout', async (req, reply) => {
    auth.logout(sessionToken(req.headers.cookie));
    return reply
      .header('Set-Cookie', auth.cookie())
      .send({ authenticated: false });
  });
}
