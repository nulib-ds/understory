import {useSearchParams} from "next/navigation";

// Every address in the app that names a collection or a work, built in one
// place.
//
// A collection's slug and a work's id travel in the query string, not the path.
// The UI is a static export served from S3, and a static export can only serve
// paths it built: /collection/[slug] would need every slug at build time, and
// slugs are created at run time. The query string needs nothing at build time,
// and CloudFront redirects the older path-shaped links (AdminRouterFunction in
// template.yml).

const enc = encodeURIComponent;

export const collectionPath = (slug) => `/collection?slug=${enc(slug)}`;

export const workPath = (slug, workId) => `/collection/work?slug=${enc(slug)}&id=${enc(workId)}`;

export const collectionSearchPath = (slug) => `/collection/search?slug=${enc(slug)}`;

// The slug and work id of the current address. Every page using it is wrapped
// in <Suspense> (see its page.jsx), which a static export requires of
// useSearchParams.
export function useRouteParams() {
  const params = useSearchParams();
  return {slug: params.get("slug") || null, workId: params.get("id") || null};
}
