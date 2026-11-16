import GitBranch from "../git-branch/main.js";

export default class GitNew extends GitBranch {
  init(p, cx) {
    super.init({ ...(p ?? {}), mode: "new" }, cx);
  }
}
