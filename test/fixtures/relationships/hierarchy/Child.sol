pragma solidity 0.8.37;

import "./Base.sol";
import {Parent as AliasParent} from "./Base.sol";
import * as NS from "./Base.sol";

contract Direct is Parent {}

contract ViaAlias is AliasParent {}

contract ViaNamespace is NS.Parent {}

contract MissingBase is Absent {}

contract Grandchild is Direct, Diamond {}
