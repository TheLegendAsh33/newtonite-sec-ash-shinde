export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api";

export type ApiFailure = {
  code?: string;
  message?: string;
  current_version?: number;
};

export class ApiError extends Error {
  status: number;
  detail: ApiFailure | string | undefined;

  constructor(status: number, detail: ApiFailure | string | undefined) {
    const message = typeof detail === "string" ? detail : detail?.message;
    super(message ?? `Request failed (${status}).`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, "The server could not be reached. Check that the API is running.");
  }

  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    let detail = body?.detail;
    // FastAPI validation failures carry a list of field issues, rather than our domain error shape.
    if (Array.isArray(detail)) {
      detail = detail.map((issue: { loc?: unknown[]; msg?: string }) => {
        const field = issue.loc?.filter((part) => part !== "body" && part !== "query").join(" ").replaceAll("_", " ");
        return `${field ? `${field}: ` : ""}${issue.msg ?? "Invalid value"}`;
      }).join(". ");
    }
    throw new ApiError(response.status, detail);
  }
  return body as T;
}
