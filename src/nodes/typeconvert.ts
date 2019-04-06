import * as ts from 'typescript';
import { StringVarType, CType, UniversalVarType, NumberVarType, BooleanVarType, ArrayType, StructType, DictType } from "../types";
import { CodeTemplate, CodeTemplateFactory } from "../template";
import { CExpression } from "./expressions";
import { IScope } from "../program";
import { isNode } from "../typeguards";
import { CArraySize, CSimpleElementAccess } from "./elementaccess";
import { CVariable } from "./variable";

@CodeTemplate(`
{#if isUniversalVar}
    {expression}
{#elseif isString}
    js_var_from_str({expression})
{#elseif isNumber}
    js_var_from_int16_t({expression})
{#elseif isBoolean}
    js_var_from_uint8_t({expression})
{#elseif isArray}
    js_var_from_array({expression})
{#elseif isDict}
    js_var_from_dict({expression})
{#else}
    /** converting {expression} to js_var is not supported yet */
{/if}`)
export class CAsUniversalVar {
    public isUniversalVar: boolean;
    public isString: boolean;
    public isNumber: boolean;
    public isBoolean: boolean;
    public isArray: boolean;
    public isDict: boolean;
    public expression: CExpression;
    constructor (scope: IScope, expr: ts.Node | CExpression, type?: CType) {
        this.expression = isNode(expr) ? CodeTemplateFactory.createForNode(scope, expr) : expr;
        type = type || isNode(expr) && scope.root.typeHelper.getCType(expr);

        this.isUniversalVar = type === UniversalVarType;
        this.isString = type === StringVarType;
        this.isNumber = type === NumberVarType;
        this.isBoolean = type === BooleanVarType;
        this.isArray = type instanceof ArrayType;
        this.isDict = type instanceof StructType || type instanceof DictType;

        if (type === StringVarType)
            scope.root.headerFlags.js_var_from_str = true;
        if (type === NumberVarType)
            scope.root.headerFlags.js_var_from_int16_t = true;
        if (type === BooleanVarType)
            scope.root.headerFlags.js_var_from_uint8_t = true;
        if (type instanceof ArrayType)
            scope.root.headerFlags.js_var_array = true;
        if (type instanceof StructType || type instanceof DictType)
            scope.root.headerFlags.js_var_dict = true;

        scope.root.headerFlags.js_var = true;
    }
}


@CodeTemplate(`
{#if isNumber || isBoolean}
    {expression}
{#elseif isString}
    str_to_int16_t({expression})
{#elseif isUniversalVar}
    js_var_to_number({expression})
{#elseif isSingleElementStaticArray}
    {arrayFirstElementAsNumber}
{#else}
    js_var_from(JS_VAR_NAN)
{/if}`)
export class CAsNumber {
    public expression: CExpression;
    public isNumber: boolean;
    public isString: boolean;
    public isBoolean: boolean;
    public isUniversalVar: boolean;
    public isSingleElementStaticArray: boolean = false;
    public arrayFirstElementAsNumber: CExpression;
    constructor(scope: IScope, expr: ts.Node | CExpression, public type?: CType) {
        this.expression = isNode(expr) ? CodeTemplateFactory.createForNode(scope, expr) : expr;
        type = type || isNode(expr) && scope.root.typeHelper.getCType(expr);

        this.isNumber = type === NumberVarType;
        this.isString = type === StringVarType;
        this.isBoolean = type === BooleanVarType;
        this.isUniversalVar = type === UniversalVarType;
        
        if (type instanceof ArrayType && !type.isDynamicArray && type.capacity === 1) {
            this.isSingleElementStaticArray = true;
            this.arrayFirstElementAsNumber = new CAsNumber(scope, new CSimpleElementAccess(scope, type, this.expression, "0"), type.elementType);
        }
    }
}

@CodeTemplate(`
{#statements}
    {#if isArrayOfString}
        {lengthVarName} = {arraySize};
        for ({iteratorVarName} = 0; {iteratorVarName} < {arraySize}; {iteratorVarName}++)
            {lengthVarName} += strlen({arrayElement});
    {#elseif isArrayOfUniversalVar}
        {lengthVarName} = {arraySize};
        for ({iteratorVarName} = 0; {iteratorVarName} < {arraySize}; {iteratorVarName}++) {
            {lengthVarName} += strlen({tmpVarName} = js_var_to_str({arrayElement}, &{needDisposeVarName}));
            if ({needDisposeVarName})
                free((void *){tmpVarName});
        }
    {/if}
{/statements}
{#if isNumber}
    STR_INT16_T_BUFLEN
{#elseif isString}
    strlen({arg})
{#elseif isBoolean}
    (5-{arg})
{#elseif isArrayOfNumber}
    (STR_INT16_T_BUFLEN + 1) * {arraySize}
{#elseif isArrayOfBoolean}
    6 * {arraySize}
{#elseif isArrayOfObj}
    16 * {arraySize}
{#elseif isArrayOfString || isArrayOfUniversalVar}
    {lengthVarName}
{#elseif isArrayOfArray}
    /* determining string length of array {arg} is not supported yet */
{#else}
    15
{/if}`)
export class CAsString_Length {
    public isNumber: boolean;
    public isString: boolean;
    public isBoolean: boolean;
    public isArray: boolean;
    public isArrayOfString: boolean;
    public isArrayOfNumber: boolean;
    public isArrayOfBoolean: boolean;
    public isArrayOfUniversalVar: boolean;
    public isArrayOfArray: boolean;
    public isArrayOfObj: boolean;
    public arraySize: CArraySize;
    public arrayElement: CSimpleElementAccess;
    public tmpVarName: string;
    public needDisposeVarName: string;
    public lengthVarName: string;
    public iteratorVarName: string;
    constructor(scope: IScope, node: ts.Node, public arg: CExpression, public type: CType) {
        this.isNumber = type === NumberVarType;
        this.isString = type === StringVarType;
        this.isBoolean = type === BooleanVarType;
        this.isArrayOfString = type instanceof ArrayType && type.elementType === StringVarType;
        this.isArrayOfNumber = type instanceof ArrayType && type.elementType === NumberVarType;
        this.isArrayOfBoolean = type instanceof ArrayType && type.elementType === BooleanVarType;
        this.isArrayOfUniversalVar = type instanceof ArrayType && type.elementType === UniversalVarType;
        this.isArrayOfArray = type instanceof ArrayType && type.elementType instanceof Array;
        this.isArrayOfObj = type instanceof ArrayType && (type.elementType instanceof DictType || type.elementType instanceof StructType);
        this.arraySize = type instanceof ArrayType && new CArraySize(scope, arg, type);

        if (this.isArrayOfString || this.isArrayOfUniversalVar) {
            this.iteratorVarName = scope.root.symbolsHelper.addIterator(node);
            scope.variables.push(new CVariable(scope, this.iteratorVarName, NumberVarType));
            this.arrayElement = new CSimpleElementAccess(scope, type, arg, this.iteratorVarName);
            this.lengthVarName = scope.root.symbolsHelper.addTemp(node, "len");
            scope.variables.push(new CVariable(scope, this.lengthVarName, NumberVarType));

            scope.root.headerFlags.strings = true;
        }

        if (this.isArrayOfUniversalVar) {
            this.tmpVarName = scope.root.symbolsHelper.addTemp(node, "tmp", false);
            this.needDisposeVarName = scope.root.symbolsHelper.addTemp(node, "need_dispose", false);
            if (!scope.variables.some(v => v.name == this.tmpVarName))
                scope.variables.push(new CVariable(scope, this.tmpVarName, StringVarType));
            if (!scope.variables.some(v => v.name == this.needDisposeVarName))
                scope.variables.push(new CVariable(scope, this.needDisposeVarName, BooleanVarType));

            scope.root.headerFlags.js_var_to_str = true;
        }
    }
}

@CodeTemplate(`
{#if isNumber}
    str_int16_t_cat({buf}, {arg});
{#elseif isString}
    strcat({buf}, {arg});
{#elseif isBoolean}
    strcat({buf}, {arg} ? "true" : "false");
{#elseif isUniversalVar}
    strcat({buf}, ({tmpVarName} = js_var_to_str({arg}, &{needDisposeVarName})));
    if ({needDisposeVarName})
        free((void *){tmpVarName});
{#elseif isArray}
    for ({iteratorVarName} = 0; {iteratorVarName} < {arraySize}; {iteratorVarName}++) {
        if ({iteratorVarName} != 0)
            strcat({buf}, ",");
        {arrayElementCat}
    }
{#else}
    strcat({buf}, "[object Object]");
{/if}
`)
export class CAsString_Concat {
    public isNumber: boolean;
    public isString: boolean;
    public isBoolean: boolean;
    public isUniversalVar: boolean;
    public tmpVarName: string;
    public needDisposeVarName: string;
    public isArray: boolean = false;
    public iteratorVarName: string;
    public arrayElementCat: CAsString_Concat;
    public arraySize: CArraySize;
    constructor(scope: IScope, node: ts.Node, public buf: CExpression, public arg: CExpression, public type: CType) {
        this.isNumber = type === NumberVarType;
        this.isString = type === StringVarType;
        this.isBoolean = type === BooleanVarType;
        this.isUniversalVar = type === UniversalVarType;
        if (this.isUniversalVar) {
            this.tmpVarName = scope.root.symbolsHelper.addTemp(node, "tmp", false);
            this.needDisposeVarName = scope.root.symbolsHelper.addTemp(node, "need_dispose", false);
            if (!scope.variables.some(v => v.name == this.tmpVarName))
                scope.variables.push(new CVariable(scope, this.tmpVarName, StringVarType));
            if (!scope.variables.some(v => v.name == this.needDisposeVarName))
                scope.variables.push(new CVariable(scope, this.needDisposeVarName, BooleanVarType));

            scope.root.headerFlags.js_var_to_str = true;
        }
        if (type instanceof ArrayType) {
            this.isArray = true;
            this.iteratorVarName = scope.root.symbolsHelper.addIterator(node);
            scope.variables.push(new CVariable(scope, this.iteratorVarName, NumberVarType));
            const arrayElement = new CSimpleElementAccess(scope, type, arg, this.iteratorVarName);
            this.arrayElementCat = new CAsString_Concat(scope, node, buf, arrayElement, type.elementType);
            this.arraySize = new CArraySize(scope, arg, type);
        }
    }
}