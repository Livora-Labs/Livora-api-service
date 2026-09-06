import { SetMetadata } from '@nestjs/common';

export const REQUIRE_IDEMPOTENCY_KEY = 'REQUIRE_IDEMPOTENCY_KEY';
export const RequireIdempotency = () =>
  SetMetadata(REQUIRE_IDEMPOTENCY_KEY, true);
