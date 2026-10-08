const config = {
  resolve: { alias: { "@": "/app/src" } },
  cacheDir: "/audit/cache",
  test: {
    environment: "node",
    include: ["/audit/*.test.ts"],
    exclude: [],
    maxWorkers: 1,
    reporters: ["default", "json"],
    outputFile: { json: "/audit/results.json" },
  },
};
export default config;
