import {dirname} from "node:path";
import {fileURLToPath} from "node:url";

// ui/ is the app's root: everything it runs is under here. Left to itself, Next
// guesses the root from the nearest lockfile, and there are several above it.
const appRoot = dirname(fileURLToPath(import.meta.url));

// A static export, written to out/. The stack serves it from its UI bucket
// through AdminDistribution, and every Understory instance runs the same build:
// nothing about a stack is compiled in, because the UI reads /config.json at
// run time (src/lib/config.js).
//
// So there is no server: no redirects() (AdminRouterFunction in template.yml
// does those at the edge) and no dynamic path segments (a collection's slug
// and a work's id are query parameters; src/lib/routes.js).
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  outputFileTracingRoot: appRoot,
  turbopack: {root: appRoot},
};

export default nextConfig;
