pragma solidity 0.8.37;
import "./binding-base.sol";
import "./binding-mixed-version.sol";
import {Parent as AliasParent, SameName as NamedSame, IRemote as IRemoteAlias, Helpers} from "./binding-dependency.sol";
import * as NS from "./binding-dependency.sol";
contract Root is AliasParent {
    Mixed mixed;
    function inheritedCall() internal returns (uint) { return inherited(); }
    function superCall() internal returns (uint) { return super.inherited(); }
    function overloaded(uint value) internal pure returns (uint) { return value; }
    function overloaded(address value) internal pure returns (uint) { return uint160(value); }
    function identity(uint value) internal pure returns (uint) { return value; }
    function functionPointer() internal pure returns (function(uint) internal pure returns (uint)) { return identity; }
    function callPointer(function(uint) internal pure returns (uint) fp, uint value) internal pure returns (uint) { return fp(value); }
    function invokeOverloads() internal pure returns (uint) { return overloaded(1); }
    function invokeThis() external returns (uint) { return this.visible(); }
    function visible() external returns (uint) { return 1; }
    function invokeInterface(IRemoteAlias remote) external returns (uint) { return remote.ping(1); }
    function invokeLibrary() internal pure returns (uint) { return Helpers.twice(1); }
    function useNamed() external returns (NamedSame) { return new NamedSame(); }
    function useNamespace() external returns (NS.SameName) { return new NS.SameName(); }
}
