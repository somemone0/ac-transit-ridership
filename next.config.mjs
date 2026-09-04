/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Cloud Run runs the container directly: `standalone` emits a self-contained
  // server with only the modules it actually imports, which is what the
  // runtime stage copies instead of the full node_modules tree.
  output: "standalone",
};

export default nextConfig;
