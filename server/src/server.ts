/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
"use strict";

import {
  IPCMessageReader,
  IPCMessageWriter,
  createConnection,
  IConnection,
  TextDocumentSyncKind,
  TextDocuments,
  TextDocument,
  Diagnostic,
  DiagnosticSeverity,
  InitializeParams,
  InitializeResult,
  TextDocumentPositionParams,
  CompletionItem,
  CompletionItemKind,
  Location,
  Range,
  DocumentSymbolParams,
  SymbolInformation,
  DidOpenTextDocumentParams,
  DidSaveTextDocumentParams
} from "vscode-languageserver";

import * as path from "path";
import * as parser from "luaparse";
import * as fs from "fs";
import * as glob from "glob";

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(
  new IPCMessageReader(process),
  new IPCMessageWriter(process)
);

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

var globalFilesParsed: Array<string> = [];

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites.
let workspaceRoot: string;
connection.onInitialize(
  (params): InitializeResult => {
    workspaceRoot = params.rootPath;
    var files = glob.sync(workspaceRoot + "/Scripts/*.lua");
    for (var i = 0; i < files.length; i++) {
      let file = "/Scripts/" + files[i].replace(/^.*[\\\/]/, "");
      if (!fs.lstatSync(file).isFile()) break;
      parseDependency(null, file, true);
    }
    files = glob.sync(workspaceRoot + "/../_fallback/Scripts/*.lua");
    for (var i = 0; i < files.length; i++) {
      let file = "/../_fallback/Scripts/" + files[i].replace(/^.*[\\\/]/, "");
      if (!fs.lstatSync(file).isFile()) break;
      parseDependency(null, file, true);
    }
    return {
      capabilities: {
        // Tell the client that the server works in FULL text document sync mode
        textDocumentSync: documents.syncKind,
        // Tell the client that the server support code complete
        documentSymbolProvider: true,
        definitionProvider: true
      }
    };
  }
);

class LuaFile {
  uri: string;
  ischanged: boolean;
  dependency: string[];
  assignments: Array<{
    base: any;
    label: string;
    range: Range;
    uri: string;
  }>;
  locals: Array<{ label: string; range: Range; uri: string }>;
  identifiers: Array<{ name: string; range: Range }>;
  parameters: Array<{ label: string; range: Range; uri: string }>;
  functions: Array<{ label: string; range: Range; uri: string; base: any }>;
  symbolslist: SymbolInformation[];

  constructor(_uri: string) {
    this.uri = _uri;
    this.reset();
  }

  reset(): void {
    this.dependency = [];
    this.symbolslist = [];
    this.assignments = [];
    this.locals = [];
    this.identifiers = [];
    this.parameters = [];
    this.functions = [];
  }
}

var IncludeKeyWords: { [key: string]: boolean } = {};
var filesParsed: { [key: string]: LuaFile } = {};

/*var cururi = ""*/
// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.

documents.onDidChangeContent(change => {
  //var textContent = change.document.getText();
  var uniuri = uniformPath(change.document.uri);

  var luaFile = filesParsed[uniuri];
  if (!luaFile) {
    luaFile = new LuaFile(uniuri);
    filesParsed[uniuri] = luaFile;
    luaFile.ischanged = false;
    var content = documents.get(change.document.uri).getText();
    var tb = parser.parse(content, {
      comments: false,
      locations: true,
      luaversion: LuaVersion
    });
    parse2(uniuri, [], tb, false);
  }
  luaFile.ischanged = true;
});

function uniformPath(pathUri: string): string {
  var uri: string = decodeURIComponent(pathUri);
  uri = uri.replace(/\w:/g, matchedStr => {
    return matchedStr.toLowerCase();
  });
  uri = uri.replace(/\\/g, "/");
  return uri;
}

function parseDependency(
  parentUri: string | null,
  dependencyPath: string,
  global?: boolean
) {
  if (global == undefined) global = false;
  var text = fs.readFileSync(dependencyPath);
  var uri2 = "file:///" + dependencyPath;
  if (global) uri2 = "file:///" + workspaceRoot + dependencyPath;
  uri2 = uniformPath(uri2);

  var luaFile: LuaFile = filesParsed[uri2];
  if (!luaFile) {
    luaFile = new LuaFile(uri2);
    filesParsed[uri2] = luaFile;
    var tb2 = parser.parse(text.toString(), {
      comments: false,
      locations: true,
      luaversion: LuaVersion
    });
    parse2(uri2, null, tb2, true);
  }
  if (global) globalFilesParsed.push(uri2);
  if (parentUri == null) return;
  luaFile = filesParsed[parentUri];
  if (luaFile.dependency.indexOf(uri2) < 0) luaFile.dependency.push(uri2);
}

function GetLoc(obj: any): any {
  return {
    start: { line: obj.loc.start.line - 1, character: obj.loc.start.column },
    end: { line: obj.loc.end.line - 1, character: obj.loc.end.column }
  };
}

function getVariable(tb: any): any {
  switch (tb.type) {
    case "Identifier":
      return {
        base: null,
        label: tb.name,
        range: GetLoc(tb)
      };
    case "MemberExpression":
      return {
        base: tb.base,
        label: tb.identifier.name,
        range: GetLoc(tb.identifier)
      };
    default:
      return {};
  }
}

function searchluafile(relpath: string, isRequire: boolean = false): string[] {
  // ?;?.lua;$luapath/?;$luapath/?.lua
  if (relpath == null) {
    return null;
  }

  //If lua file is imported by 'require'.
  if (isRequire) {
    relpath = relpath.replace(/\./g, path.sep);
    relpath = path.normalize(relpath);
  }

  let relpath_lua = relpath + ".lua";

  var pathArr: string[] = [
    relpath,
    relpath_lua,
    path.join(workspaceRoot, relpath),
    path.join(workspaceRoot, relpath_lua)
  ];

  for (var i = 0; i < luapaths.length; i++) {
    pathArr.push(path.join(luapaths[i], relpath));
    pathArr.push(path.join(luapaths[i], relpath_lua));
  }

  var element: string = null;
  var list: string[] = [];
  for (var index = 0; index < pathArr.length; index++) {
    element = pathArr[index];
    if (fs.existsSync(element) && list.indexOf(path.resolve(element)) < 0) {
      list.push(path.resolve(element));
    }
  }
  return list;
}
function updatefile(uri: string, isSaving: boolean) {
  var uniuri = uniformPath(uri);
  var luaFile = filesParsed[uniuri];
  try {
    if (luaFile == null) {
      luaFile = new LuaFile(uniuri);
      filesParsed[uniuri] = luaFile;
      luaFile.ischanged = false;
      var content = documents.get(uri).getText();
      var tb = parser.parse(content, {
        comments: false,
        locations: true,
        luaversion: LuaVersion
      });
      parse2(uniuri, [], tb, false);
    } else if (luaFile.ischanged == true && isSaving == true) {
      luaFile.ischanged = false;
      var content = documents.get(uri).getText();
      var tb = parser.parse(content, {
        comments: false,
        locations: true,
        luaversion: LuaVersion
      });
      luaFile.reset();
      parse2(uniuri, [], tb, false);
    }
  } catch (err) {
    console.log(`${err} : ${uri}`);
    //connection.window.showErrorMessage(`${err} : ${uri}`);
  }
}

function findParent(parent: any[]): any {
  for (var i = 0; i < parent.length; i++) {
    if (parent[i] != null && parent[i].identifier != null) {
      return parent[i];
    }
  }
}

function getAsNameStr(element: any) {
  if (typeof element == "string") return element;
  switch (element.type) {
    case "MemberExpression":
      return getAsNameStr(element.identifier);
    case "Identifier":
      return element.name;
  }
  return "";
}

function getBaseFor(element: any) {
  if (typeof element == "string") return element;
  switch (element.type) {
    case "MemberExpression":
      return element.base;
    case "Identifier":
      return null;
  }
  return null;
}

function getBaseStrFor(element: any) {
  return getAsBaseStr(getBaseFor(element));
}

function getAsBaseStr(element: any) {
  if (typeof element == "string") return element;
  switch (element.type) {
    case "MemberExpression":
      return (
        getAsBaseStr(element.base) +
        element.indexer +
        getAsBaseStr(element.identifier)
      );
    case "Identifier":
      return element.name;
  }
  return element.label != null ? element.label : "";
}

function parse2(uri: string, parentStack: any[], tb: any, onlydefine: boolean) {
  if (tb == undefined) return;
  switch (tb.type) {
    case "Identifier":
      filesParsed[uri].identifiers.push({
        name: tb.name,
        range: GetLoc(tb)
      });
      if (onlydefine) {
        break;
      }
      break;
    case "IndexExpression":
      if (tb.base != null) {
        parse2(uri, parentStack, tb.base, onlydefine);
      }
      if (tb.index != null) {
        parse2(uri, parentStack, tb.index, onlydefine);
      }
      break;
    case "MemberExpression":
      if (tb.base == null || tb.identifier == null) {
        break;
      }
      parse2(uri, parentStack, tb.base, onlydefine);
      filesParsed[uri].identifiers.push({
        name: getAsNameStr(tb.identifier),
        //base: tb.base,
        range: GetLoc(tb.identifier)
      });
      filesParsed[uri].identifiers.push({
        name: getAsBaseStr(tb.base) + tb.indexer + getAsNameStr(tb.identifier),
        range: GetLoc(tb.identifier)
      });
      break;
    case "LocalStatement":
      if (tb.variables != null) {
        for (var i = 0; i < tb.variables.length; i++) {
          if (tb.variables[i] != null && tb.variables[i].type == "Identifier") {
            filesParsed[uri].locals.push({
              uri: uri,
              label: tb.variables[i].name,
              range: GetLoc(tb.variables[i])
            });
          }
        }
        parse2(uri, parentStack, tb.variables, onlydefine);
      }
      break;
    case "TableCallExpression":
      parse2(uri, parentStack, tb.base, onlydefine);
      for (var i = 0; i < tb.arguments.length; i++) {
        parse2(uri, parentStack, tb.arguments[i], onlydefine);
      }
      break;
    case "AssignmentStatement":
      if (tb.variables == null) {
        break;
      }
      for (var i = 0; i < tb.variables.length; i++) {
        parse2(uri, parentStack, tb.variables[i], onlydefine);
        var assignment = null;
        if (tb.variables[i].type == "Identifier") {
          assignment = {
            uri: uri,
            base: null,
            label: tb.variables[i].name,
            range: GetLoc(tb.variables[i])
          };
        } else if (
          tb.variables[i].type == "MemberExpression" &&
          tb.variables[i].identifier != null
        ) {
          assignment = {
            uri: uri,
            base: tb.variables[i].base,
            label: tb.variables[i].identifier.name,
            range: GetLoc(tb.variables[i])
          };
        }
        if (assignment == null) break;
        filesParsed[uri].assignments.push(assignment);
        if (tb.init != null && tb.init[i] != null) {
          parse2(uri, parentStack, tb.init[i], onlydefine);
          if (
            tb.init[i].type == "TableConstructorExpression" &&
            tb.fields != null &&
            tb.fields[i] != null &&
            tb.field[i].type == "TableKeyString"
          ) {
            var name = getAsNameStr(tb.fields[i].key);
            if (name == null || name == "") break;
            for (var i = 0; i < tb.fields.length; i++) {
              filesParsed[uri].assignments.push({
                uri: uri,
                base: assignment,
                label: name,
                range: GetLoc(tb)
              });
            }
          }
        }
      }
      break;
    case "TableConstructorExpression":
      if (tb.fields != null) {
        for (var i = 0; i < tb.fields.length; i++) {
          if (tb.fields[i].type == "TableKeyString") {
            parse2(uri, parentStack, tb.fields[i].value, onlydefine);
          } else {
            parse2(uri, parentStack, tb.fields[i], onlydefine);
          }
        }
      }
      break;
    case "TableKeyString":
    case "TableKey":
      if (tb.key != null) {
        parse2(uri, parentStack, tb.key, onlydefine);
      }
    case "TableValue":
      if (tb.value != null) {
        parse2(uri, parentStack, tb.value, onlydefine);
      }
      break;
    case "IfStatement":
      if (tb.clauses != null) {
        for (var i = 0; i < tb.clauses.length; i++) {
          parse2(uri, parentStack, tb.clauses[i], onlydefine);
        }
      }
      break;
    case "ForNumericStatement":
      if (tb.start != null) {
        parse2(uri, parentStack, tb.start, onlydefine);
      }
      if (tb.end != null) {
        parse2(uri, parentStack, tb.end, onlydefine);
      }
      if (tb.body != null) {
        for (var i = 0; i < tb.body.length; i++) {
          parse2(uri, parentStack, tb.body[i], onlydefine);
        }
      }
      break;
    case "ForGenericStatement":
      if (tb.iterators != null) {
        for (var i = 0; i < tb.iterators.length; i++) {
          parse2(uri, parentStack, tb.iterators[i], onlydefine);
        }
      }
      if (tb.body != null) {
        for (var i = 0; i < tb.body.length; i++) {
          parse2(uri, parentStack, tb.body[i], onlydefine);
        }
      }
      break;
    case "ReturnStatement":
      if (tb.arguments != null) {
        for (var i = 0; i < tb.arguments.length; i++) {
          parse2(uri, parentStack, tb.arguments[i], onlydefine);
        }
      }
      break;
    case "CallStatement":
      parse2(uri, parentStack, tb.expression, onlydefine);

      break;
    case "CallExpression":
      if (IncludeKeyWords[tb.base.name] == true) {
        var absPaths = searchluafile(
          tb.arguments[0].value,
          tb.base.name == "require"
        );
        if (absPaths != null) {
          for (var i = 0; i < absPaths.length; i++) {
            parseDependency(uri, absPaths[i]);
          }
        }
      }
      parse2(uri, parentStack, tb.base, onlydefine);
      if (tb.arguments != null) {
        for (var i = 0; i < tb.arguments.length; i++) {
          parse2(uri, parentStack, tb.arguments[i], onlydefine);
        }
      }
      break;
    case "BinaryExpression":
    case "LogicalExpression":
      if (tb.left != null) {
        parse2(uri, parentStack, tb.left, onlydefine);
      }
      if (tb.right != null) {
        parse2(uri, parentStack, tb.right, onlydefine);
      }
      break;
    case "UnaryExpression":
      if (tb.argument != null)
        parse2(uri, parentStack, tb.argument, onlydefine);
      break;
    case "FunctionDeclaration":
      var name;
      name = "";
      if (tb.identifier != null) {
        name = getAsNameStr(tb.identifier);
        filesParsed[uri].functions.push({
          uri: uri,
          label: name,
          range: GetLoc(tb),
          base: getBaseFor(tb.identifier)
        });
      }
      if (name != "") {
        var symbol: SymbolInformation = SymbolInformation.create(
          tb.identifier.name, //should this be base+"./:"+name ?
          0,
          GetLoc(tb),
          uri
        );
        filesParsed[uri].symbolslist.push(symbol);
      }
      if (tb.parameters != null) {
        for (var i = 0; i < tb.parameters.length; i++) {
          var val = tb.parameters[i];
          if (val.type == "Identifier") {
            filesParsed[uri].parameters.push({
              label: val.name,
              range: GetLoc(val),
              uri: uri
            });
          }
          parse2(uri, parentStack, tb.parameters[i], onlydefine);
        }
      }

      if (tb.body != null) {
        for (var i = 0; i < tb.body.length; i++) {
          var stack2 = [tb].concat(parentStack);
          parse2(uri, stack2, tb.body[i], onlydefine);
        }
      }
      break;

    case "DoStatement":
    case "RepeatStatement":
    case "WhileStatement":
    case "IfClause":
    case "ElseifClause":
      if (tb.condition != null) {
        parse2(uri, parentStack, tb.condition, onlydefine);
      }
    case "ElseClause":
    case "Chunk":

    default:
      if (tb.body != null) {
        for (var i = 0; i < tb.body.length; i++) {
          parse2(uri, parentStack, tb.body[i], onlydefine);
        }
      }
      break;
  }
}
// The settings interface describe the server relevant settings part
interface Settings {
  luaforvscode: LuaForVsCodeSettings;
}

// These are the example settings we defined in the client's package.json
// file
interface LuaForVsCodeSettings {
  luapath: string;
  includekeyword: string;
  luaversion: number;
}

// hold the maxNumberOfProblems setting
var luapaths: string[] = [];
let LuaVersion: number;
// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration(change => {
  let settings = <Settings>change.settings;
  let luapathconfig = settings.luaforvscode.luapath;
  if (luapathconfig != null) {
    luapaths = luapathconfig.split(";");
  }

  LuaVersion = settings.luaforvscode.luaversion;
  let includekeyword: string = settings.luaforvscode.includekeyword;
  if (includekeyword == null) {
    includekeyword = "";
  }
  let includeKeyWords = includekeyword.split(",");

  if (includeKeyWords.length > 0) {
    IncludeKeyWords = {};
    for (var keyword of includeKeyWords) {
      IncludeKeyWords[keyword] = true;
    }
  } else {
    IncludeKeyWords = {};
    IncludeKeyWords["Include"] = true;
    IncludeKeyWords["Require"] = true;
    IncludeKeyWords["require"] = true;
    IncludeKeyWords["dofile"] = true;
    IncludeKeyWords["include"] = true;
  }

  // Revalidate any open text documents
});

connection.onDidChangeWatchedFiles(change => {
  // Monitored files have change in VSCode
  //connection.console.log('We recevied an file change event');
});

connection.onDocumentSymbol(
  (documentSymbolParams: DocumentSymbolParams): SymbolInformation[] => {
    updatefile(documentSymbolParams.textDocument.uri, false);
    var symbolslist = [];
    var uri = uniformPath(documentSymbolParams.textDocument.uri);
    var luaFile: LuaFile = filesParsed[uri];
    if (luaFile) symbolslist = luaFile.symbolslist;

    return symbolslist;
  }
);

function definitionsFor(luaFile: LuaFile, identifier: any, listToAddTo: any) {
  var list = listToAddTo != null && listToAddTo != undefined ? listToAddTo : [];
  var params = luaFile.parameters;
  var assigns = luaFile.assignments;
  var funcs = luaFile.functions;
  var locals = luaFile.locals;
  for (var i = 0; i < locals.length; i++) {
    if (locals[i].label == identifier.name && identifier.base == null) {
      var loc = {
        label: locals[i].label,
        uri: locals[i].uri,
        range: locals[i].range
      };
      list.push(loc);
    }
  }
  for (var i = 0; i < params.length; i++) {
    if (params[i].label == identifier.name && identifier.base == null) {
      var loc = {
        label: params[i].label,
        uri: params[i].uri,
        range: params[i].range
      };
      list.push(loc);
    }
  }
  for (var i = 0; i < assigns.length; i++) {
    if (
      assigns[i].label == identifier.name &&
      (identifier.base == null ||
        getBaseStrFor(identifier.base) == getBaseStrFor(assigns[i].base))
    ) {
      var loc = {
        label: assigns[i].label,
        uri: assigns[i].uri,
        range: assigns[i].range
      };
      list.push(loc);
    }
  }
  for (var i = 0; i < assigns.length; i++) {
    if (
      assigns[i].label == identifier.name &&
      (identifier.base == null ||
        getBaseStrFor(identifier.base) == getBaseStrFor(assigns[i].base))
    ) {
      var loc = {
        label: assigns[i].label,
        uri: assigns[i].uri,
        range: assigns[i].range
      };
      list.push(loc);
    }
  }
  return list;
}

function globalDefinitions(identifier) {
  var list = [];
  for (var i = 0; i < globalFilesParsed.length; i++) {
    var uri = globalFilesParsed[i];
    var luaFile = filesParsed[uri];
    if (!luaFile) break;
    definitionsFor(luaFile, identifier, list);
  }
  connection.console.log(JSON.stringify(globalFilesParsed));
  connection.console.log(JSON.stringify(filesParsed));
  return list;
}

var onDef;
onDef = (
  textDocumentPositionParams: TextDocumentPositionParams
): Location[] => {
  updatefile(textDocumentPositionParams.textDocument.uri, false);

  var list = [];
  var line = textDocumentPositionParams.position.line;
  var character = textDocumentPositionParams.position.character;

  var uri = uniformPath(textDocumentPositionParams.textDocument.uri);
  var luaFile: LuaFile = filesParsed[uri];
  var ids = luaFile.identifiers;
  var identifier = null;

  for (var i = 0; i < ids.length; i++) {
    if (ids[i].range.start.line <= line && line <= ids[i].range.end.line) {
      if (
        ids[i].range.start.character <= character &&
        character <= ids[i].range.end.character
      ) {
        identifier = ids[i];
        break;
      }
    }
  }
  if (identifier == null) {
    connection.console.log(JSON.stringify(ids));
    connection.console.log(JSON.stringify(textDocumentPositionParams));
    return list;
  }
  connection.console.log(JSON.stringify(identifier));
  connection.console.log(JSON.stringify(textDocumentPositionParams));
  definitionsFor(luaFile, identifier, list);
  connection.console.log(JSON.stringify(list));
  if (list.length == 0) return globalDefinitions(identifier);
  return list;
};
connection.onDefinition(onDef);

// This handler resolve additional information for the item selected in
// the completion list.
// connection.onCompletionResolve((item: CompletionItem): CompletionItem => {

// 	return item;
// });

connection.onDidSaveTextDocument((params: DidSaveTextDocumentParams) => {
  updatefile(params.textDocument.uri, true);
});

// connection.onDidOpenTextDocument((params:DidOpenTextDocumentParams) => {
// 	// A text document got opened in VSCode.
// 	// params.uri uniquely identifies the document. For documents store on disk this is a file URI.
// 	// params.text the initial full content of the document.

// });

/*
connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	var uniuri = uniformPath(change.document.uri);

	var luaFile = filesParsed[uniuri];
	if( !luaFile) {
		luaFile = new LuaFile(uniuri);
		filesParsed[uniuri] = luaFile;
	}
	luaFile.ischanged = true;
});
connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.uri uniquely identifies the document.

});
*/

// Listen on the connection
connection.listen();
