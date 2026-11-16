import GitBranch from "../git-branch/main.js";

export default class GitRename extends GitBranch {
  init(p, cx) {
    super.init({ ...(p ?? {}), mode: "rename" }, cx);
  }
}
