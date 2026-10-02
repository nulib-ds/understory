import {dirname} from "node:path";
import {fileURLToPath} from "node:url";

// ui/ is the app's root: everything it runs is under here. Left to itself, Next
// guesses the root from the nearest lockfile, and there are several above it.
const appRoot = dirname(fileURLToPath(import.meta.url));

// The admin UI runs on Amplify Hosting's server (WEB_COMPUTE), not as a static
// export: collection slugs and work ids are created at runtime, so the
// [slug] and [workId] routes cannot be prerendered. A server also makes
// redirects an ordinary Next.js feature rather than an Amplify rule.
/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: appRoot,
  turbopack: {root: appRoot},
  async redirects() {
    // Older links. The collections list is the home page.
    return [{source: "/collections", destination: "/", permanent: false}];
  },
};

export default nextConfig;
