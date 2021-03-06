
import {
	IPCMessageReader, IPCMessageWriter,
	createConnection, IConnection,
	TextDocuments, InitializeResult,
	WorkspaceFolder,
	TextDocumentSyncKind,
	CompletionList,
	CompletionItemKind,
	InsertTextFormat,
	TextEdit,
	Range,
	CancellationToken
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import classesList from './langServer/reqClassList';
import * as acornLoose from 'acorn-loose';
//import * as acorn from 'acorn';
import * as acornWalk from 'acorn-walk';

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
const console = connection.console;

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents = new TextDocuments(TextDocument);
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

let workspaceFolders: WorkspaceFolder[] = [];

const asteriskFiles = new Set<string>();


connection.onInitialized(() => {

	connection.workspace.onDidChangeWorkspaceFolders((event) => {
		connection.workspace.getWorkspaceFolders().then(_workspaceFolders => {
			workspaceFolders = _workspaceFolders || [];

			workspaceFolders = workspaceFolders.filter(workspaceFolder => workspaceFolder.uri.includes('file:'))


		});
		connection.console.log('Workspace folder change event received');
	});
});



connection.onInitialize((params): InitializeResult => {

	connection.console.log('Script Server init...' + JSON.stringify(params.workspaceFolders));

	// The VS Code htmlhint settings have changed. Revalidate all documents.
	// connection.onDidChangeConfiguration((args) => {
	// 	onDidChangeConfiguration(connection, documents, args);
	// });


	workspaceFolders = params.workspaceFolders || [];

	workspaceFolders = workspaceFolders.filter(workspaceFolder => workspaceFolder.uri.includes('file:'))

	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: TextDocumentSyncKind.Full,
			//hoverProvider: true
			//documentLinkProvider: {
			//	resolveProvider: true
			//},
			//documentRangeFormattingProvider: true,
			//documentHighlightProvider: true,
			//hoverProvider: true,
			completionProvider: {
				resolveProvider: false
			},
			//documentSymbolProvider: true,
			workspace: {
				workspaceFolders: {
					supported: true,
					changeNotifications: true
				}
			}
		}
	}

});

function insertParents(ast) {
	(function walk(node, parent) {
		node.parent = parent;

		Object.keys(node).forEach(function (key) {
			if (key === 'parent') return;

			var child = node[key];
			if (Array.isArray(child)) {
				child.forEach(function (c) {
					if (c && typeof c.type === 'string') {
						walk(c, node);
					}
				});
			} else if (child && typeof child.type === 'string') {
				walk(child, node);
			}
		});
	})(ast, undefined);
}
interface ICompetitions {
	label: string;
	kind: CompletionItemKind;
	value: string;
	range: [number, number];
	insertTextFormat: 1;
}

const completionsList: ((activeNode: any, offset: number) => ICompetitions[])[] = [
	function (activeNode) {
		if (
			activeNode &&
			activeNode.type === 'Literal' &&
			activeNode.parent &&
			activeNode.parent.type === 'CallExpression' &&
			activeNode.parent.callee.name === 'require'
		) {

			return classesList.concat(Array.from(asteriskFiles)).map(api => {
				return {
					label: api,
					kind: CompletionItemKind.Value,
					value: api,
					range: [activeNode.start + 1, activeNode.end - 1],
					insertTextFormat: InsertTextFormat.PlainText
				}
			})
		};
		return [];
	},
	function (activeNode, offset) {
		if (
			activeNode &&
			activeNode.type === 'CallExpression' &&
			activeNode.callee.name === 'require' &&
			!activeNode.arguments.length
		) {
			return classesList.concat(Array.from(asteriskFiles)).map(api => {
				return {
					label: `'${api}'`,
					kind: CompletionItemKind.Value,
					value: `'${api}'`,
					range: [offset, offset],
					insertTextFormat: InsertTextFormat.PlainText
				}
			})
		};
		return [];
	}
]

async function completion(content: string, offset: number, cancelToken: CancellationToken, reqTime: number) {
	const ast = await acornLoose.parse(content, { ecmaVersion: 5 });
	if (cancelToken.isCancellationRequested) {
		console.log('Canceled completion request');
	}

	if (ast && offset !== undefined) {
		const findNodeAround: Function = acornWalk.findNodeAround;
		const activeNode: any = findNodeAround(ast, offset, () => true)?.node;
		insertParents(ast);

		const completions = completionsList.reduce((acc, completionFn) => {
			const res = completionFn(activeNode, offset)
			if (res) {
				return acc.concat(res);
			} else {
				return acc;
			}
		}, [] as ICompetitions[]);

		if (completions.length) {
			console.log(`${completions.length} completion: ${Date.now() - reqTime}ms `);
			return completions;
		}
	}
	console.log(`no completion: ${Date.now() - reqTime}ms `);
	return [];
}

function getReplaceRange(document: TextDocument, replaceStart: number, replaceEnd: number): Range {
	return {
		start: document.positionAt(replaceStart),
		end: document.positionAt(replaceEnd)
	};
}

connection.onNotification('cartridges.files', ({ list }) => {


	list?.forEach(cartridge => {
		cartridge?.files?.forEach(file => {
			asteriskFiles.add('*' + file.replace('.js', ''));
		});
	});
	console.info('got cartridges files list');
});

connection.onCompletion(async (params, cancelToken) => {
	const reqTime = Date.now();

	const document = documents.get(params.textDocument.uri);
	if (!document) {
		connection.console.error('125: Unable find document')
		return;
	}
	const offset = document.offsetAt(params.position);

	if (document.languageId === 'javascript') {
		const completions = await completion(document.getText(), offset, cancelToken, reqTime);

		if (!cancelToken.isCancellationRequested && completions?.length) {

			const list: CompletionList = {
				isIncomplete: false,
				items: completions.map(completion => {
					return {
						label: completion.label,
						kind: completion.kind,
						textEdit: TextEdit.replace(
							getReplaceRange(document, completion.range[0], completion.range[1]),
							completion.value
						),
						insertTextFormat: completion.insertTextFormat
					};
				})
			};
			return list;
		}
	}
});

// A text document has changed. Validate the document.
documents.onDidChangeContent((event) => {
	// the contents of a text document has changed
	//validateTextDocument(connection, event.document);
});


// Listen on the connection
connection.listen();

process.once('uncaughtException', err => {
	console.error(String(err) + '\n' + err.stack);
	connection.dispose();
	process.exit(-1);
})

