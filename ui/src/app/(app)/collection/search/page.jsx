import {Suspense} from "react";
import CollectionSearchPage from "../../../../screens/CollectionSearchPage";

// /collection/search?slug=… (lib/routes.js). Linked from nowhere on purpose.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <CollectionSearchPage />
    </Suspense>
  );
}
