import {Suspense} from "react";
import CollectionWorksPage from "../../../screens/CollectionWorksPage";

// /collection?slug=…. The slug is in the query string, not the path, so this
// one exported page serves every collection (lib/routes.js). Suspense is what
// a static export requires around useSearchParams.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <CollectionWorksPage />
    </Suspense>
  );
}
