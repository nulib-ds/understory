import {createContext, useContext, useId, useLayoutEffect} from "react";

// The page gate's registry, shared by PageReady (components/PageReady.jsx) and
// every component inside it that loads something on mount. It lives apart from
// the component because react-refresh wants a component module to export
// components only.
export const PageReadyContext = createContext(null);

// Hold the page hidden until `ready` is true — pass true once this
// component's FIRST load has settled, successfully or not. A failed request
// counts as ready: the error is content, and the page should show it.
//
// Only the first load matters. The gate opens once per page and never closes
// again, so later refreshes can do what they like without the page vanishing.
//
// A layout effect, not a passive one: every participant mounted in a commit
// has to be registered before the gate checks whether they are all done, and
// layout effects all run inside the commit, ahead of the gate's check.
//
// Outside a PageReady this is a no-op, so a component can report whether or
// not the page it lands on is gated.
export function useReportReady(ready) {
  const gate = useContext(PageReadyContext);
  const id = useId();
  useLayoutEffect(() => {
    if (!gate) return undefined;
    gate.set(id, Boolean(ready));
    return () => gate.remove(id);
  }, [gate, id, ready]);
}
