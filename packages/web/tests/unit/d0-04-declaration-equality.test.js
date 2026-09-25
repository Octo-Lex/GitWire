// D0-04: the independent surface inventory and declaration registry must stay
// exactly aligned, including resource and mutation identity metadata.

import {
  CONSEQUENTIAL_SURFACE_MANIFEST,
  expectedProtectedSurfaceIdsFromManifest,
} from "../../src/services/auth/consequentialSurfaceManifest.js";
import { registerAllProtectedSurfaces } from "../../src/services/auth/declarations.js";
import {
  getProtectedSurface,
  listProtectedSurfaces,
} from "../../src/services/auth/protectedSurfaces.js";

describe("D0-04 declaration equality", () => {
  beforeAll(() => {
    registerAllProtectedSurfaces();
  });

  test("declaration ids exactly equal the independent required set", () => {
    expect(listProtectedSurfaces().map((surface) => surface.id)).toEqual(
      [...expectedProtectedSurfaceIdsFromManifest()].sort(),
    );
  });

  test("consequential declarations exactly match independent authority metadata", () => {
    for (const expected of CONSEQUENTIAL_SURFACE_MANIFEST) {
      expect(getProtectedSurface(expected.surfaceId)).toMatchObject({
        id: expected.surfaceId,
        kind: expected.kind,
        permission: expected.permission,
        resourceType: expected.resourceType,
        principalSource: expected.principalSource,
        authMethod: expected.authMethod,
        observeHandling: expected.observeHandling,
        resourceResolver: expected.resourceResolver,
        mutationIdentity: expected.mutationIdentity,
      });
    }
  });
});
