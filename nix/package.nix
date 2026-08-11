{
  lib,
  buildNpmPackage,
  nodejs_22,
}:

buildNpmPackage {
  pname = "pi-task-compaction";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../extensions
      ../src
      ../test
      ../index.ts
      ../LICENSE
      ../package-lock.json
      ../package.json
      ../README.md
      ../tsconfig.json
    ];
  };

  nodejs = nodejs_22;
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-kmO9RtKvuzPhGIJO9YXB9vJX8+FNetlR96M/y7pONwE=";
  npmBuildScript = "check";

  # buildNpmPackage normally creates a global-style npm tree. Pi accepts a
  # package directory directly, so expose the package itself at the output root.
  postInstall = ''
    packageRoot="$out/lib/node_modules/pi-task-compaction"
    rm -rf "$packageRoot/node_modules"

    shopt -s dotglob
    mv "$packageRoot"/* "$out/"
    rm -rf "$out/lib" "$out/bin"
  '';

  meta = {
    description = "Provider-agnostic, agent-driven task-region compaction for pi";
    homepage = "https://github.com/spott/pi-task-compaction";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
