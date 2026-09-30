/**
 * Is public self-signup open? Super Admin → Core settings → Signup.
 *
 * `undefined` while loading, so callers don't flash a "registration closed"
 * notice (or hide the signup link) before the answer arrives. This only
 * shapes the UI — POST /api/auth/signup refuses a closed signup on its own.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchSignupPolicy } from '@/lib/emailOtp';

export function useSignupEnabled(): boolean | undefined {
  const { data } = useQuery({
    queryKey: ['public_signup_policy'],
    queryFn: fetchSignupPolicy,
    staleTime: 30_000,
  });
  return data?.enabled;
}
