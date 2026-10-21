import { factorySpace } from "micromark-factory-space";
import { markdownLineEnding } from "micromark-util-character";
const codes = { dash: 45, eof: null, exclamationMark: 33, greaterThan: 62 };
const types = { data: "data", lineEnding: "lineEnding", linePrefix: "linePrefix" };
function commentFromMarkdown(_options) {
  return {
    canContainEols: ["comment"],
    enter: {
      comment(_) {
        this.buffer();
      }
    },
    exit: {
      comment(token) {
        this.resume();
      }
    }
  };
}
const tokenize = (effects, ok, nok) => {
  return start;
  function start(code) {
    effects.enter("comment");
    effects.consume(code);
    return open;
  }
  function open(code) {
    if (code === codes.exclamationMark) {
      effects.consume(code);
      return declarationOpen;
    }
    return nok(code);
  }
  function declarationOpen(code) {
    if (code === codes.dash) {
      effects.consume(code);
      return commentOpen;
    }
    return nok(code);
  }
  function commentOpen(code) {
    if (code === codes.dash) {
      effects.consume(code);
      return commentStart;
    }
    return nok(code);
  }
  function commentStart(code) {
    if (code === codes.greaterThan) {
      return nok(code);
    }
    if (markdownLineEnding(code)) {
      return atLineEnding(code);
    }
    effects.enter(types.data);
    if (code === codes.dash) {
      effects.consume(code);
      return commentStartDash;
    }
    return comment2(code);
  }
  function commentStartDash(code) {
    if (code === codes.greaterThan) {
      return nok(code);
    }
    return comment2(code);
  }
  function comment2(code) {
    if (code === codes.eof) {
      return nok(code);
    }
    if (code === codes.dash) {
      effects.consume(code);
      return commentClose;
    }
    if (markdownLineEnding(code)) {
      effects.exit(types.data);
      return atLineEnding(code);
    }
    effects.consume(code);
    return comment2;
  }
  function atLineEnding(code) {
    effects.enter(types.lineEnding);
    effects.consume(code);
    effects.exit(types.lineEnding);
    return factorySpace(effects, afterPrefix, types.linePrefix);
  }
  function afterPrefix(code) {
    if (markdownLineEnding(code)) {
      return atLineEnding(code);
    }
    effects.enter(types.data);
    return comment2(code);
  }
  function commentClose(code) {
    if (code === codes.dash) {
      effects.consume(code);
      return end;
    }
    return comment2(code);
  }
  function end(code) {
    if (code === codes.greaterThan) {
      effects.exit(types.data);
      effects.enter("commentEnd");
      effects.consume(code);
      effects.exit("commentEnd");
      effects.exit("comment");
      return ok(code);
    }
    if (code === codes.dash) {
      effects.consume(code);
      return end;
    }
    return comment2(code);
  }
};
const comment = {
  flow: { [60]: { tokenize, concrete: true } },
  text: { [60]: { tokenize } }
};
export {
  comment,
  commentFromMarkdown
};
