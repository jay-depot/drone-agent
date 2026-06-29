/**
 * HTTP Request Utilities
 *
 * Simple HTTP client for integration testing.
 */

import type { RequestOptions } from './index.js';

/**
 * Make an HTTP request
 */
export async function request<T>(
  url: string,
  options: RequestOptions = {}
): Promise<T> {
  const { method = 'GET', headers = {}, body } = options;

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `HTTP ${method} ${url} failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Make a GET request
 */
export async function get<T>(url: string): Promise<T> {
  return request<T>(url);
}

/**
 * Make a POST request
 */
export async function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, { method: 'POST', body });
}

/**
 * Make a PUT request
 */
export async function put<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, { method: 'PUT', body });
}

/**
 * Make a DELETE request
 */
export async function del<T>(url: string): Promise<T> {
  return request<T>(url, { method: 'DELETE' });
}
