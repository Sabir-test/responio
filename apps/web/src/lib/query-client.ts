import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Don't retry on 401/403 — redirect to login instead
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
        return failureCount < 2;
      },
    },
  },
});

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
