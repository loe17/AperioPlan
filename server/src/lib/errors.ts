export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
  }
}
export const badRequest = (m: string) => new HttpError(400, m, 'bad_request');
export const unauthorized = (m = 'Bitte anmelden') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Keine Berechtigung') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Nicht gefunden') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');
