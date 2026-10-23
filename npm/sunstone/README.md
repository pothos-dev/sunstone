# Sunstone

A markdown editor with first-class [Open Knowledge Format](https://github.com/pothos-dev/sunstone/tree/main/docs/okf) support, served to your browser.

```sh
npx sunstone-md ./docs --browser
```

That opens the folder as a Bundle at http://localhost:3000/ and opens it in your browser (leave out `--browser` to only print the address). Edits save straight to disk. It runs for one user only: it listens on localhost and has no sign-in.

```
sunstone [BUNDLE] [--browser] [--port PORT] [--bind ADDR] [--allow-host NAME]...
```

Run `npx sunstone-md --help` for the details. This is the same editor as the desktop app's `sunstone serve`; for a native window, get the app from the [releases page](https://github.com/pothos-dev/sunstone/releases).
