import { createParamDecorator, ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';

/** The realm role of FF's operators (D12). */
export const OPERATOR_ROLE = 'ff-operator';
/** The Keycloak client of the admin dashboard: only its tokens reach the admin routes (D12). */
export const ADMIN_CLIENT = 'ff-admin';

export const IS_ADMIN = 'ff:admin';

/**
 * Marks a controller's routes as the admin dashboard's (P-70, D12): the global
 * guard lets in only an operator, with a token issued to ff-admin, and every
 * write needs a reason. They never act for a customer account.
 */
export const AdminRoutes = () => SetMetadata(IS_ADMIN, true);

export const CHANGES_NOTHING = 'ff:admin-changes-nothing';

/**
 * Marks an admin route whose POST changes nothing, such as a preview that
 * takes a draft in its body (P-73): it needs no reason. Every other write
 * does, and is still for operators only.
 */
export const ChangesNothing = () => SetMetadata(CHANGES_NOTHING, true);

/** The operator calling an admin route. */
export interface Operator {
  /** Keycloak's user ID. */
  id: string;
  email: string;
  name?: string;
}

export interface RequestWithOperator {
  operator?: Operator;
}

/** The operator, in an admin route's handler: `@CurrentOperator() operator: Operator`. */
export const CurrentOperator = createParamDecorator((_data: unknown, ctx: ExecutionContext): Operator => {
  const operator = ctx.switchToHttp().getRequest<RequestWithOperator>().operator;
  if (!operator) throw new UnauthorizedException('Authentication required');
  return operator;
});

/** A reason, as every admin change needs one: written to the audit log with the change. */
export const REASON_LENGTH = { min: 3, max: 500 } as const;
export function validReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= REASON_LENGTH.min && value.length <= REASON_LENGTH.max;
}

/** The header that carries a change's reason when the body is a file, such as a withholding certificate (P-35): URI-encoded. */
export const REASON_HEADER = 'x-ff-reason';

/** A change's reason: in the JSON body, or with a file for a body, in the X-FF-Reason header. Null when neither has one. */
export function reasonOf(request: { body?: unknown; headers: Record<string, string | string[] | undefined> }): string | null {
  const fromBody = Buffer.isBuffer(request.body) ? undefined : (request.body as { reason?: unknown } | undefined)?.reason;
  if (validReason(fromBody)) return fromBody;
  const header = request.headers[REASON_HEADER];
  if (typeof header !== 'string') return null;
  try {
    const decoded = decodeURIComponent(header);
    return validReason(decoded) ? decoded : null;
  } catch {
    return null; // not URI-encoded
  }
}
