export class UserError extends Error {}
export function need(value, message) { if (!value) throw new UserError(message); }
export const safeText = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 500);
