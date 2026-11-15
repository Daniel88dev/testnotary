import { redirect } from "next/navigation";

// /docs opens the first page of "Start here".
export default function DocsHome(): never {
  redirect("/docs/intro");
}
