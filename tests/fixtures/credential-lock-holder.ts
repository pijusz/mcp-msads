import { withFileLock } from "@/auth/secure-file";

const [credentialPath] = process.argv.slice(2);
if (!credentialPath) throw new Error("credential path is required");

await withFileLock(credentialPath, async () => {
  process.stdout.write("acquired\n");
  await new Promise(() => undefined);
});
