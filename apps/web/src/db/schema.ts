// The Drizzle schema. Every table here is a history table: the app role may only INSERT and
// SELECT (see drizzle/0000_roles.sql), so every state change is a new row. Tables arrive with the
// tickets that need them; run `pnpm db:generate` after editing this file.
export {};
