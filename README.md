# herdr-mobile

```sh
git clone https://github.com/suchetanrs/herdr-mobile.git
cd herdr-mobile
curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
export PATH="$HOME/.local/share/fnm:$PATH" && eval "$(fnm env)"
fnm install 22 && fnm use 22
npm ci
npm run build
scripts/install-service.sh --no-build
echo "http://$(tailscale ip -4):8787/#token=$(cat ~/.config/herdr-mobile/token)"
```
