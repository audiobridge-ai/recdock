import { createCloudMiddleware } from './http.ts';
import { LibraryService } from './library/service.ts';
import { createLibraryHandler } from './library/http.ts';

export function createApplication() {
  const library = new LibraryService();
  const middleware = createCloudMiddleware(undefined, Date.now, {
    library: createLibraryHandler(library),
    // Unavailable audio storage must not prevent account logout or device use.
    onAccountGranted: async account => { await library.grantAccount(account).catch(() => {}); },
    onAccountRevoked: async account => { await library.revokeAccount(account).catch(() => {}); },
  });
  return { middleware, library, close: () => library.close() };
}
