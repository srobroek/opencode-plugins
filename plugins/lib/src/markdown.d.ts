// Bun inlines a `with { type: "text" }` import of a markdown file as its contents.
declare module "*.md" {
  const text: string
  export default text
}
