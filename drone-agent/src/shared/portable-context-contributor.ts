import {
  DRONE_PORTABLE_CONTEXT_CAPABILITY_ID,
  type DronePluginRegistration,
  type DronePortableContextCapability,
  type DronePortableContextContributor,
} from 'drone-core';

/**
 * Register a portable-context contributor via the engine-seeded
 * `portable-context` capability. No-op when the capability is unavailable
 * (it is always present in the real engine; absent only in minimal mocks).
 */
export function registerPortableContextContributor(
  registration: DronePluginRegistration,
  contributor: DronePortableContextContributor
): void {
  const capability = registration.request<DronePortableContextCapability>(
    DRONE_PORTABLE_CONTEXT_CAPABILITY_ID
  );
  capability?.registerContributor(contributor);
}
