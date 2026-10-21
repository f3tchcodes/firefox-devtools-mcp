import type { BiDiFacade, FirefoxExtension } from './bidi.js';

export interface ListExtensionsFilters {
  ids?: string[];
  name?: string;
  isActive?: boolean;
}

export async function listExtensions(
  bidi: BiDiFacade,
  filters?: ListExtensionsFilters
): Promise<FirefoxExtension[]> {
  const { ids, name, isActive } = filters ?? {};
  const requestedIds = ids?.length ? new Set(ids) : undefined;
  const searchName = name?.toLowerCase();

  const result = await bidi.sendCommand('webExtension.moz:listExtensions', {});

  return (result.extensions ?? [])
    .filter((extension) => !requestedIds || requestedIds.has(extension.id))
    .filter((extension) => !searchName || extension.name.toLowerCase().includes(searchName))
    .filter((extension) => typeof isActive !== 'boolean' || extension.isActive === isActive);
}
