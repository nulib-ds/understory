"use client";

import {useEffect} from "react";
import {useRouter} from "next/navigation";

// Any unknown path lands on the home page, as it always has.
export default function NotFound() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return null;
}
