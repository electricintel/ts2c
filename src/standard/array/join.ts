import * as ts from 'typescript';
import { CodeTemplate, CodeTemplateFactory, CTemplateBase } from '../../template';
import { StandardCallResolver, IResolver } from '../../standard';
import { ArrayType, StringVarType, NumberVarType } from '../../types/ctypes';
import { IScope } from '../../program';
import { CVariable } from '../../nodes/variable';
import { CExpression } from '../../nodes/expressions';
import { CString } from '../../nodes/literals';
import { CElementAccess, CArraySize, CSimpleElementAccess } from '../../nodes/elementaccess';
import { TypeHelper } from '../../types/typehelper';

@StandardCallResolver
class ArrayConcatResolver implements IResolver {
    public matchesNode(typeHelper: TypeHelper, call: ts.CallExpression) {
        if (call.expression.kind != ts.SyntaxKind.PropertyAccessExpression)
            return false;
        let propAccess = <ts.PropertyAccessExpression>call.expression;
        let objType = typeHelper.getCType(propAccess.expression);
        return (propAccess.name.getText() == "join" || propAccess.name.getText() == "toString") && objType instanceof ArrayType;
    }
    public returnType(typeHelper: TypeHelper, call: ts.CallExpression) {
        return StringVarType;
    }
    public createTemplate(scope: IScope, node: ts.CallExpression) {
        return new CArrayJoin(scope, node);
    }
    public needsDisposal(typeHelper: TypeHelper, node: ts.CallExpression) {
        // if parent is expression statement, then this is the top expression
        // and thus return value is not used, so the temporary variable will not be created
        return node.parent.kind != ts.SyntaxKind.ExpressionStatement;
    }
    public getTempVarName(typeHelper: TypeHelper, node: ts.CallExpression) {
        return "tmp_joined_string";
    }
    public getEscapeNode(typeHelper: TypeHelper, node: ts.CallExpression) {
        return null;
    }
}

@CodeTemplate(`
{#statements}
    {#if !topExpressionOfStatement}
        {tempVarName} = malloc({calculatedStringLength});
        assert({tempVarName} != NULL);
        ((char *){tempVarName})[0] = '\\0';
        for ({iteratorVarName} = 0; {iteratorVarName} < {arraySize}; {iteratorVarName}++) {
            if ({iteratorVarName} > 0)
                strcat((char *){tempVarName}, {separator});
            {catFuncName}((char *){tempVarName}, {arrayElement});
        }
    {/if}
{/statements}
{#if !topExpressionOfStatement}
    {tempVarName}
{/if}`)
class CArrayJoin extends CTemplateBase {
    public topExpressionOfStatement: boolean;
    public tempVarName: string = '';
    public iteratorVarName: string;
    public separator: CExpression;
    public varAccess: CElementAccess = null;
    public arraySize: CArraySize;
    public arrayElement: CSimpleElementAccess;
    public calculatedStringLength: CCalculateStringSize;
    public catFuncName: string;
    constructor(scope: IScope, call: ts.CallExpression) {
        super();
        this.topExpressionOfStatement = call.parent.kind == ts.SyntaxKind.ExpressionStatement;


        if (!this.topExpressionOfStatement) {
            let propAccess = <ts.PropertyAccessExpression>call.expression;
            let type = <ArrayType>scope.root.typeHelper.getCType(propAccess.expression);
            this.varAccess = new CElementAccess(scope, propAccess.expression);
            this.arraySize = new CArraySize(scope, this.varAccess, type);
            this.iteratorVarName = scope.root.symbolsHelper.addIterator(call);
            scope.variables.push(new CVariable(scope, this.iteratorVarName, NumberVarType));
            this.arrayElement = new CSimpleElementAccess(scope, type, this.varAccess, this.iteratorVarName);
            this.catFuncName = type.elementType == NumberVarType ? "str_int16_t_cat" : "strcat";
            this.tempVarName = scope.root.memoryManager.getReservedTemporaryVarName(call);
            if (!scope.root.memoryManager.variableWasReused(call))
                scope.variables.push(new CVariable(scope, this.tempVarName, "char *"));
            this.calculatedStringLength = new CCalculateStringSize(scope, this.varAccess, this.iteratorVarName, type, call);
            if (call.arguments.length > 0 && propAccess.name.getText() == "join")
                this.separator = CodeTemplateFactory.createForNode(scope, call.arguments[0]);
            else
                this.separator = new CString(scope, ',');
            scope.root.headerFlags.malloc = true;
            scope.root.headerFlags.strings = true;
            if (type.isDynamicArray)
                scope.root.headerFlags.array = true;
            if (type.elementType == NumberVarType)
                scope.root.headerFlags.str_int16_t_cat = true;
        }
    }

}

@CodeTemplate(`
{#statements}
    {#if arrayOfStrings}
        {lengthVarName} = 0;
        for ({iteratorVarName} = 0; {iteratorVarName} < {arraySize}; {iteratorVarName}++)
            {lengthVarName} += strlen({arrayElement});
    {/if}
{/statements}
{#if type.isDynamicArray && arrayOfStrings}
    {arraySize} == 0 ? 1 : {lengthVarName} + strlen({separator})*({arraySize}-1) + 1
{#elseif arrayCapacity > 0 && arrayOfStrings}
    {lengthVarName} + strlen({separator})*({arraySize}-1) + 1
{#elseif type.isDynamicArray && arrayOfNumbers}
    {varAccess}->size == 0 ? 1 : STR_INT16_T_BUFLEN*{varAccess}->size + strlen({separator})*({arraySize}-1) + 1
{#elseif arrayCapacity > 0 && arrayOfNumbers}
    STR_INT16_T_BUFLEN*{arraySize}+strlen({separator})*({arraySize}-1)+1
{#else}
    1
{/if}`)
class CCalculateStringSize {
    public lengthVarName: string;
    public arrayOfStrings: boolean;
    public arrayOfNumbers: boolean;
    public arrayCapacity: string;
    public arraySize: CArraySize;
    public arrayElement: CSimpleElementAccess;
    constructor(scope: IScope, public varAccess: CElementAccess, public iteratorVarName: string, public type: ArrayType, node: ts.Node) {
        this.arrayOfStrings = type.elementType == StringVarType;
        this.arrayOfNumbers = type.elementType == NumberVarType;
        this.arrayCapacity = type.capacity+"";
        this.arraySize = new CArraySize(scope, this.varAccess, type);
        this.arrayElement = new CSimpleElementAccess(scope, type, varAccess, iteratorVarName);
        if (this.arrayOfStrings) {
            this.lengthVarName = scope.root.symbolsHelper.addTemp(node, "len");
            scope.variables.push(new CVariable(scope, this.lengthVarName, NumberVarType));
        }
    }
}
