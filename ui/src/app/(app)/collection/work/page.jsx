import {Suspense} from "react";
import WorkPage from "../../../../screens/WorkPage";

// /collection/work?slug=…&id=… (lib/routes.js).
export default function Page() {
  return (
    <Suspense fallback={null}>
      <WorkPage />
    </Suspense>
  );
}
