import GitBranch from "../git-branch/main.js";

export default class GitMerge extends GitBranch {
  init(p, cx) {
    super.init({ ...(p ?? {}), mode: "merge" }, cx);
  }
}
