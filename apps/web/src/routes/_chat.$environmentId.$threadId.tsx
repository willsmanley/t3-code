import { createFileRoute } from "@tanstack/react-router";

import { validateThreadRouteSearch } from "../threadRoutes";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: validateThreadRouteSearch,
  component: () => null,
});
