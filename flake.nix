{
  description = "Provider-agnostic, agent-driven task-region compaction for pi";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      overlays.default = final: _prev: {
        pi-task-compaction = final.callPackage ./nix/package.nix { };
      };

      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ self.overlays.default ];
          };
        in
        {
          default = pkgs.pi-task-compaction;
          inherit (pkgs) pi-task-compaction;
        }
      );

      checks = forAllSystems (system: {
        default = self.packages.${system}.default;
      });

      formatter = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.writeShellApplication {
          name = "nixfmt";
          runtimeInputs = [ pkgs.nixfmt ];
          text = ''
            if (( $# == 0 )); then
              mapfile -d "" files < <(find . -type f -name '*.nix' -not -path './.git/*' -print0)
              if (( ''${#files[@]} )); then
                nixfmt "''${files[@]}"
              fi
            else
              exec nixfmt "$@"
            fi
          '';
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nixfmt
              nodejs_22
              prefetch-npm-deps
            ];
          };
        }
      );
    };
}
