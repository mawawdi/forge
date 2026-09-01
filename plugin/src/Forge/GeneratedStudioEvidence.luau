--!strict
-- Generated from packages/studio-evidence/manifest/studio-capability-manifest.json.
-- This is Forge's sole Studio authoring/readback/reflection capability table.
-- Facts accepted by factMaterial are ordinary tables whose fields are limited to
-- strings, booleans, finite numbers, canonical Studio values, and sequences.
local Generated = {}
Generated.manifestHash = "b27c84c59df3ca520dc0247360d2e0d00282ed76bc4378e97fb11e0ceb54fc2f"
Generated.connectorBuildHash = "a84be536e51194fcaadb1036dcdd585f6f1b8d70f8db3de1f75fd5600fab91f5"
Generated.manifest = { ["attributes"] = { ["codecs"] = { "boolean", "number_f32", "string_utf8" }, ["maximumCount"] = 64, ["maximumNameUtf8Bytes"] = 100, ["maximumStringUtf8Bytes"] = 4096, ["reservedPrefix"] = "_forge" }, ["classes"] = { { ["creatable"] = true, ["name"] = "Attachment", ["properties"] = { { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector3" }, ["codec"] = "vector3_f32", ["declaringClass"] = "Attachment", ["maximum"] = 100000, ["name"] = "Axis", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector3", ["scriptType"] = "Vector3" }, ["serialized"] = false }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "CFrame" }, ["codec"] = "cframe_f32x12", ["declaringClass"] = "Attachment", ["maximumAbsoluteTranslation"] = 100000, ["name"] = "CFrame", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "CoordinateFrame", ["scriptType"] = "CFrame" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector3" }, ["codec"] = "vector3_f32", ["declaringClass"] = "Attachment", ["maximum"] = 100000, ["name"] = "SecondaryAxis", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector3", ["scriptType"] = "Vector3" }, ["serialized"] = false }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "Attachment", ["name"] = "Visible", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "Beam", ["properties"] = { { ["catalogType"] = { ["category"] = "class", ["name"] = "Attachment" }, ["codec"] = "instance_ref", ["declaringClass"] = "Beam", ["name"] = "Attachment0", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["referenceClass"] = "Attachment", ["reflection"] = { ["engineType"] = "RefType", ["instanceType"] = "Attachment", ["scriptType"] = "Instance" } }, { ["catalogType"] = { ["category"] = "class", ["name"] = "Attachment" }, ["codec"] = "instance_ref", ["declaringClass"] = "Beam", ["name"] = "Attachment1", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["referenceClass"] = "Attachment", ["reflection"] = { ["engineType"] = "RefType", ["instanceType"] = "Attachment", ["scriptType"] = "Instance" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Beam", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "Brightness", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "ColorSequence" }, ["codec"] = "color_sequence", ["declaringClass"] = "Beam", ["maximumEntries"] = 20, ["name"] = "Color", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "ColorSequence", ["scriptType"] = "ColorSequence" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Beam", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "CurveSize0", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Beam", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "CurveSize1", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "Beam", ["name"] = "Enabled", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "Beam", ["name"] = "FaceCamera", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Beam", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "LightEmission", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Beam", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "LightInfluence", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "NumberSequence" }, ["codec"] = "number_sequence", ["declaringClass"] = "Beam", ["maximumEntries"] = 20, ["name"] = "Transparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "NumberSequence", ["scriptType"] = "NumberSequence" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Beam", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "Width0", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Beam", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "Width1", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "BoolValue", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "BoolValue", ["name"] = "Value", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "CFrameValue", ["properties"] = { { ["catalogType"] = { ["category"] = "datatype", ["name"] = "CFrame" }, ["codec"] = "cframe_f32x12", ["declaringClass"] = "CFrameValue", ["maximumAbsoluteTranslation"] = 100000, ["name"] = "Value", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "CoordinateFrame", ["scriptType"] = "CFrame" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "Color3Value", ["properties"] = { { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "Color3Value", ["name"] = "Value", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "Decal", ["properties"] = { { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "Decal", ["name"] = "Color3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Decal", ["maximum"] = 360000, ["minimum"] = -360000, ["name"] = "Rotation", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Decal", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "Transparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector2" }, ["codec"] = "vector2_f32", ["declaringClass"] = "Decal", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "UVOffset", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector2", ["scriptType"] = "Vector2" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector2" }, ["codec"] = "vector2_f32", ["declaringClass"] = "Decal", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "UVScale", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector2", ["scriptType"] = "Vector2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "Decal", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "ZIndex", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "Folder", ["properties"] = {  }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "Frame", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "Active", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector2" }, ["codec"] = "vector2_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 100, ["minimum"] = -100, ["name"] = "AnchorPoint", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector2", ["scriptType"] = "Vector2" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "GuiObject", ["name"] = "BackgroundColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "BackgroundTransparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "GuiObject", ["name"] = "BorderColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "BorderSizePixel", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "ClipsDescendants", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "LayoutOrder", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "UDim2" }, ["codec"] = "udim2", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "Position", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "UDim2", ["scriptType"] = "UDim2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 360000, ["minimum"] = -360000, ["name"] = "Rotation", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "UDim2" }, ["codec"] = "udim2", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "Size", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "UDim2", ["scriptType"] = "UDim2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "Visible", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "ZIndex", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "ImageLabel", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "Active", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector2" }, ["codec"] = "vector2_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 100, ["minimum"] = -100, ["name"] = "AnchorPoint", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector2", ["scriptType"] = "Vector2" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "GuiObject", ["name"] = "BackgroundColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "BackgroundTransparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "GuiObject", ["name"] = "BorderColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "BorderSizePixel", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "ClipsDescendants", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "ImageLabel", ["name"] = "ImageColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector2" }, ["codec"] = "vector2_f32", ["declaringClass"] = "ImageLabel", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "ImageRectOffset", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector2", ["scriptType"] = "Vector2" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector2" }, ["codec"] = "vector2_f32", ["declaringClass"] = "ImageLabel", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "ImageRectSize", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector2", ["scriptType"] = "Vector2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "ImageLabel", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "ImageTransparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "LayoutOrder", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "UDim2" }, ["codec"] = "udim2", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "Position", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "UDim2", ["scriptType"] = "UDim2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 360000, ["minimum"] = -360000, ["name"] = "Rotation", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "UDim2" }, ["codec"] = "udim2", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "Size", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "UDim2", ["scriptType"] = "UDim2" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Rect" }, ["codec"] = "rect", ["declaringClass"] = "ImageLabel", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "SliceCenter", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Rect2D", ["scriptType"] = "Rect" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "ImageLabel", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "SliceScale", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "UDim2" }, ["codec"] = "udim2", ["declaringClass"] = "ImageLabel", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "TileSize", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "UDim2", ["scriptType"] = "UDim2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "Visible", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "ZIndex", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "IntValue", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int64" }, ["codec"] = "int64_decimal", ["declaringClass"] = "IntValue", ["name"] = "Value", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int64", ["scriptType"] = "number" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "LocalScript", ["properties"] = {  }, ["source"] = "required_on_create_and_writeable" }, { ["creatable"] = true, ["name"] = "Model", ["properties"] = {  }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "ModuleScript", ["properties"] = {  }, ["source"] = "required_on_create_and_writeable" }, { ["creatable"] = true, ["name"] = "NumberValue", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "double" }, ["codec"] = "number_f64", ["declaringClass"] = "NumberValue", ["maximum"] = 1000000000, ["minimum"] = -1000000000, ["name"] = "Value", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "double", ["scriptType"] = "number" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "ObjectValue", ["properties"] = { { ["catalogType"] = { ["category"] = "class", ["name"] = "Instance" }, ["codec"] = "instance_ref", ["declaringClass"] = "ObjectValue", ["name"] = "Value", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["referenceClass"] = "Instance", ["reflection"] = { ["engineType"] = "RefType", ["instanceType"] = "Instance", ["scriptType"] = "Instance" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "Part", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "BasePart", ["name"] = "Anchored", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "CFrame" }, ["codec"] = "cframe_f32x12", ["declaringClass"] = "BasePart", ["maximumAbsoluteTranslation"] = 100000, ["name"] = "CFrame", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "CoordinateFrame", ["scriptType"] = "CFrame" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "BasePart", ["name"] = "CanCollide", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "BasePart", ["name"] = "CanQuery", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "BasePart", ["name"] = "CanTouch", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "BasePart", ["name"] = "CastShadow", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "string" }, ["codec"] = "string_utf8", ["declaringClass"] = "BasePart", ["maximumUtf8Bytes"] = 100, ["name"] = "CollisionGroup", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "string", ["scriptType"] = "string" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "BasePart", ["name"] = "Color", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" }, ["serialized"] = false }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "BasePart", ["name"] = "Massless", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["allowed"] = { "Air", "Asphalt", "Basalt", "Brick", "Cardboard", "Carpet", "CeramicTiles", "ClayRoofTiles", "Cobblestone", "Concrete", "CorrodedMetal", "CrackedLava", "DiamondPlate", "Fabric", "Foil", "ForceField", "Glacier", "Glass", "Granite", "Grass", "Ground", "Ice", "LeafyGrass", "Leather", "Limestone", "Marble", "Metal", "Mud", "Neon", "Pavement", "Pebble", "Plaster", "Plastic", "Rock", "RoofShingles", "Rubber", "Salt", "Sand", "Sandstone", "Slate", "SmoothPlastic", "Snow", "Water", "Wood", "WoodPlanks" }, ["catalogType"] = { ["category"] = "enum", ["name"] = "Material" }, ["codec"] = "enum_name", ["declaringClass"] = "BasePart", ["name"] = "Material", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Enum", ["enumType"] = "Material", ["scriptType"] = "EnumItem" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "BasePart", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "Reflectance", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector3" }, ["codec"] = "vector3_f32", ["declaringClass"] = "BasePart", ["maximum"] = 2048, ["minimumExclusive"] = 0, ["name"] = "Size", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector3", ["scriptType"] = "Vector3" }, ["serialized"] = false }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "BasePart", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "Transparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "ParticleEmitter", ["properties"] = { { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector3" }, ["codec"] = "vector3_f32", ["declaringClass"] = "ParticleEmitter", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "Acceleration", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector3", ["scriptType"] = "Vector3" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "ColorSequence" }, ["codec"] = "color_sequence", ["declaringClass"] = "ParticleEmitter", ["maximumEntries"] = 20, ["name"] = "Color", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "ColorSequence", ["scriptType"] = "ColorSequence" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "ParticleEmitter", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "Drag", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "ParticleEmitter", ["name"] = "Enabled", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "NumberRange" }, ["codec"] = "number_range", ["declaringClass"] = "ParticleEmitter", ["name"] = "Lifetime", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "NumberRange", ["scriptType"] = "NumberRange" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "ParticleEmitter", ["maximum"] = 10000, ["minimum"] = 0, ["name"] = "Rate", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "NumberRange" }, ["codec"] = "number_range", ["declaringClass"] = "ParticleEmitter", ["name"] = "Rotation", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "NumberRange", ["scriptType"] = "NumberRange" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "NumberSequence" }, ["codec"] = "number_sequence", ["declaringClass"] = "ParticleEmitter", ["maximumEntries"] = 20, ["name"] = "Size", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "NumberSequence", ["scriptType"] = "NumberSequence" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "NumberRange" }, ["codec"] = "number_range", ["declaringClass"] = "ParticleEmitter", ["name"] = "Speed", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "NumberRange", ["scriptType"] = "NumberRange" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector2" }, ["codec"] = "vector2_f32", ["declaringClass"] = "ParticleEmitter", ["maximum"] = 360000, ["minimum"] = -360000, ["name"] = "SpreadAngle", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector2", ["scriptType"] = "Vector2" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "NumberSequence" }, ["codec"] = "number_sequence", ["declaringClass"] = "ParticleEmitter", ["maximumEntries"] = 20, ["name"] = "Transparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "NumberSequence", ["scriptType"] = "NumberSequence" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "PointLight", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Light", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "Brightness", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "Light", ["name"] = "Color", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "Light", ["name"] = "Enabled", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "PointLight", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "Range", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "Light", ["name"] = "Shadows", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "ProximityPrompt", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "string" }, ["codec"] = "string_utf8", ["declaringClass"] = "ProximityPrompt", ["maximumUtf8Bytes"] = 200, ["name"] = "ActionText", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "string", ["scriptType"] = "string" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "ProximityPrompt", ["name"] = "Enabled", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "ProximityPrompt", ["maximum"] = 3600, ["minimum"] = 0, ["name"] = "HoldDuration", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "ProximityPrompt", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "MaxActivationDistance", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "string" }, ["codec"] = "string_utf8", ["declaringClass"] = "ProximityPrompt", ["maximumUtf8Bytes"] = 200, ["name"] = "ObjectText", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "string", ["scriptType"] = "string" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "ProximityPrompt", ["name"] = "RequiresLineOfSight", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "RemoteEvent", ["properties"] = {  }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "RemoteFunction", ["properties"] = {  }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "ScreenGui", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "ScreenGui", ["name"] = "ClipToDeviceSafeArea", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "ScreenGui", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "DisplayOrder", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "LayerCollector", ["name"] = "Enabled", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "LayerCollector", ["name"] = "ResetOnSpawn", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "Script", ["properties"] = {  }, ["source"] = "required_on_create_and_writeable" }, { ["creatable"] = true, ["name"] = "Sound", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "Sound", ["name"] = "Looped", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Sound", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "PlaybackSpeed", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Sound", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "RollOffMaxDistance", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Sound", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "RollOffMinDistance", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Sound", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "Volume", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "SpotLight", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "SpotLight", ["maximum"] = 180, ["minimum"] = 0, ["name"] = "Angle", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Light", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "Brightness", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "Light", ["name"] = "Color", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "Light", ["name"] = "Enabled", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "SpotLight", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "Range", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "Light", ["name"] = "Shadows", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "StringValue", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "string" }, ["codec"] = "string_utf8", ["declaringClass"] = "StringValue", ["maximumUtf8Bytes"] = 4096, ["name"] = "Value", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "string", ["scriptType"] = "string" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "SurfaceLight", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "SurfaceLight", ["maximum"] = 180, ["minimum"] = 0, ["name"] = "Angle", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Light", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "Brightness", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "Light", ["name"] = "Color", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "Light", ["name"] = "Enabled", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "SurfaceLight", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "Range", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "Light", ["name"] = "Shadows", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "TextButton", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "Active", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector2" }, ["codec"] = "vector2_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 100, ["minimum"] = -100, ["name"] = "AnchorPoint", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector2", ["scriptType"] = "Vector2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiButton", ["name"] = "AutoButtonColor", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "GuiObject", ["name"] = "BackgroundColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "BackgroundTransparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "GuiObject", ["name"] = "BorderColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "BorderSizePixel", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "ClipsDescendants", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "LayoutOrder", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "TextButton", ["maximum"] = 100, ["minimum"] = 0, ["name"] = "LineHeight", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "UDim2" }, ["codec"] = "udim2", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "Position", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "UDim2", ["scriptType"] = "UDim2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "TextButton", ["name"] = "RichText", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 360000, ["minimum"] = -360000, ["name"] = "Rotation", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "UDim2" }, ["codec"] = "udim2", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "Size", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "UDim2", ["scriptType"] = "UDim2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "string" }, ["codec"] = "string_utf8", ["declaringClass"] = "TextButton", ["maximumUtf8Bytes"] = 4096, ["name"] = "Text", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "string", ["scriptType"] = "string" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "TextButton", ["name"] = "TextColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "TextButton", ["maximum"] = 1000, ["minimum"] = 1, ["name"] = "TextSize", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "TextButton", ["name"] = "TextStrokeColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "TextButton", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "TextStrokeTransparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "TextButton", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "TextTransparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "Visible", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "ZIndex", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "TextLabel", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "Active", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector2" }, ["codec"] = "vector2_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 100, ["minimum"] = -100, ["name"] = "AnchorPoint", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector2", ["scriptType"] = "Vector2" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "GuiObject", ["name"] = "BackgroundColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "BackgroundTransparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "GuiObject", ["name"] = "BorderColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 1000, ["minimum"] = 0, ["name"] = "BorderSizePixel", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "ClipsDescendants", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "LayoutOrder", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "TextLabel", ["maximum"] = 100, ["minimum"] = 0, ["name"] = "LineHeight", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "UDim2" }, ["codec"] = "udim2", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "Position", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "UDim2", ["scriptType"] = "UDim2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "TextLabel", ["name"] = "RichText", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "GuiObject", ["maximum"] = 360000, ["minimum"] = -360000, ["name"] = "Rotation", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "UDim2" }, ["codec"] = "udim2", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "Size", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "UDim2", ["scriptType"] = "UDim2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "string" }, ["codec"] = "string_utf8", ["declaringClass"] = "TextLabel", ["maximumUtf8Bytes"] = 4096, ["name"] = "Text", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "string", ["scriptType"] = "string" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "TextLabel", ["name"] = "TextColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "TextLabel", ["maximum"] = 1000, ["minimum"] = 1, ["name"] = "TextSize", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "TextLabel", ["name"] = "TextStrokeColor3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "TextLabel", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "TextStrokeTransparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "TextLabel", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "TextTransparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "GuiObject", ["name"] = "Visible", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "GuiObject", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "ZIndex", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "Texture", ["properties"] = { { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Color3" }, ["codec"] = "color3_rgb8", ["declaringClass"] = "Decal", ["name"] = "Color3", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Color3", ["scriptType"] = "Color3" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Texture", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "OffsetStudsU", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Texture", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "OffsetStudsV", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Decal", ["maximum"] = 360000, ["minimum"] = -360000, ["name"] = "Rotation", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Texture", ["maximum"] = 100000, ["minimumExclusive"] = 0, ["name"] = "StudsPerTileU", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Texture", ["maximum"] = 100000, ["minimumExclusive"] = 0, ["name"] = "StudsPerTileV", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Decal", ["maximum"] = 1, ["minimum"] = 0, ["name"] = "Transparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector2" }, ["codec"] = "vector2_f32", ["declaringClass"] = "Decal", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "UVOffset", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector2", ["scriptType"] = "Vector2" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector2" }, ["codec"] = "vector2_f32", ["declaringClass"] = "Decal", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "UVScale", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector2", ["scriptType"] = "Vector2" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "int" }, ["codec"] = "int32", ["declaringClass"] = "Decal", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "ZIndex", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "int", ["scriptType"] = "number" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "Trail", ["properties"] = { { ["catalogType"] = { ["category"] = "class", ["name"] = "Attachment" }, ["codec"] = "instance_ref", ["declaringClass"] = "Trail", ["name"] = "Attachment0", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["referenceClass"] = "Attachment", ["reflection"] = { ["engineType"] = "RefType", ["instanceType"] = "Attachment", ["scriptType"] = "Instance" } }, { ["catalogType"] = { ["category"] = "class", ["name"] = "Attachment" }, ["codec"] = "instance_ref", ["declaringClass"] = "Trail", ["name"] = "Attachment1", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["referenceClass"] = "Attachment", ["reflection"] = { ["engineType"] = "RefType", ["instanceType"] = "Attachment", ["scriptType"] = "Instance" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "ColorSequence" }, ["codec"] = "color_sequence", ["declaringClass"] = "Trail", ["maximumEntries"] = 20, ["name"] = "Color", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "ColorSequence", ["scriptType"] = "ColorSequence" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "Trail", ["name"] = "Enabled", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" } }, { ["catalogType"] = { ["category"] = "primitive", ["name"] = "float" }, ["codec"] = "number_f32", ["declaringClass"] = "Trail", ["maximum"] = 100000, ["minimum"] = 0, ["name"] = "Lifetime", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "float", ["scriptType"] = "number" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "NumberSequence" }, ["codec"] = "number_sequence", ["declaringClass"] = "Trail", ["maximumEntries"] = 20, ["name"] = "Transparency", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "NumberSequence", ["scriptType"] = "NumberSequence" } }, { ["catalogType"] = { ["category"] = "datatype", ["name"] = "NumberSequence" }, ["codec"] = "number_sequence", ["declaringClass"] = "Trail", ["maximumEntries"] = 20, ["name"] = "WidthScale", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "NumberSequence", ["scriptType"] = "NumberSequence" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "Vector3Value", ["properties"] = { { ["catalogType"] = { ["category"] = "datatype", ["name"] = "Vector3" }, ["codec"] = "vector3_f32", ["declaringClass"] = "Vector3Value", ["maximum"] = 100000, ["minimum"] = -100000, ["name"] = "Value", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "Vector3", ["scriptType"] = "Vector3" } } }, ["source"] = "forbidden" }, { ["creatable"] = true, ["name"] = "WeldConstraint", ["properties"] = { { ["catalogType"] = { ["category"] = "primitive", ["name"] = "boolean" }, ["codec"] = "boolean", ["declaringClass"] = "WeldConstraint", ["name"] = "Enabled", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["reflection"] = { ["engineType"] = "bool", ["scriptType"] = "boolean" }, ["serialized"] = false }, { ["catalogType"] = { ["category"] = "class", ["name"] = "BasePart" }, ["codec"] = "instance_ref", ["declaringClass"] = "WeldConstraint", ["name"] = "Part0", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["referenceClass"] = "BasePart", ["reflection"] = { ["engineType"] = "RefType", ["instanceType"] = "BasePart", ["scriptType"] = "Instance" }, ["serialized"] = false }, { ["catalogType"] = { ["category"] = "class", ["name"] = "BasePart" }, ["codec"] = "instance_ref", ["declaringClass"] = "WeldConstraint", ["name"] = "Part1", ["proof"] = { "canonicalize", "validate", "preflight", "write", "read", "project", "compare" }, ["referenceClass"] = "BasePart", ["reflection"] = { ["engineType"] = "RefType", ["instanceType"] = "BasePart", ["scriptType"] = "Instance" }, ["serialized"] = false } }, ["source"] = "forbidden" } }, ["kind"] = "StudioCapabilityManifest", ["limits"] = { ["maximumOperations"] = 32, ["maximumProjectionBytes"] = 131072, ["maximumProjectionFacts"] = 4096, ["maximumRuntimeCalls"] = 16, ["maximumRuntimeMs"] = 20000, ["maximumRuntimeResultBytes"] = 65536, ["maximumRuntimeTargets"] = 8 }, ["operationKinds"] = { "create", "delete", "move", "update", "write_source" }, ["projectState"] = { ["facts"] = { "attributes", "inventory", "properties", "remote", "source_body", "source_hash", "tags" }, ["maximumEvidenceBytes"] = 4194304, ["maximumInstances"] = 256 }, ["roots"] = { "Lighting", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService", "ServerStorage", "SoundService", "StarterGui", "StarterPack", "StarterPlayer", "Teams", "Workspace" }, ["runtimeCapabilities"] = { { ["name"] = "base_part.position", ["result"] = "vector3_f32" }, { ["maximumIntervalMs"] = 1000, ["maximumSamples"] = 32, ["minimumIntervalMs"] = 100, ["name"] = "base_part.position_series", ["result"] = "position_series_f32" }, { ["name"] = "instance.property", ["result"] = "manifest_property" }, { ["maximumIntervalMs"] = 1000, ["maximumSamples"] = 32, ["minimumIntervalMs"] = 100, ["name"] = "instance.property_series", ["result"] = "manifest_property_series" }, { ["name"] = "instance.resolve", ["result"] = "instance_identity" } }, ["source"] = { ["evidence"] = "sha256", ["maximumUtf8Bytes"] = 48000 }, ["stateRevision"] = { ["comparableDomain"] = { "project", "requirements", "scope" }, ["projectionHashRole"] = "provenance_only", ["stateMaterial"] = { "facts", "manifest", "state_domain" } } }
-- All dispatch maps below are derived from the one generated manifest table;
-- they are indexes, not a second handwritten or generated capability list.
Generated.authoringRoots = Generated.manifest.roots
Generated.writableClasses = {}
Generated.scriptClasses = {}
Generated.resolvableClasses = { "BasePart" }
Generated.classes = {}
for _, class in ipairs(Generated.manifest.classes) do
	local properties = {}
	for _, property in ipairs(class.properties) do properties[property.name] = property end
	Generated.classes[class.name] = { creatable = class.creatable, source = class.source, properties = properties }
	table.insert(Generated.writableClasses, class.name)
	if class.source ~= "forbidden" then table.insert(Generated.scriptClasses, class.name) end
	table.insert(Generated.resolvableClasses, class.name)
end
table.sort(Generated.writableClasses)
table.sort(Generated.scriptClasses)
table.sort(Generated.resolvableClasses)
Generated.runtimeCapabilities = {}
for _, capability in ipairs(Generated.manifest.runtimeCapabilities) do Generated.runtimeCapabilities[capability.name] = capability end
-- Fixed Play-Solo runner dispatch generated from the closed runtime capability
-- manifest. The runner splices this body into its call loop; it owns no
-- capability-name branches or tables of its own.
Generated.runtimeRunnerDispatchSource = "if call.capability == \"base_part.position\" then\n\t\tlocal instance = resolved[call.targetId]\n\t\tif not string.match(target.path, \"^Workspace/\") or target.expectedClass ~= \"BasePart\" or not instance or not instance:IsA(\"BasePart\") then\n\t\t\ttable.insert(results, { id = call.id, capability = \"base_part.position\", targetId = call.targetId, status = \"unavailable\" })\n\t\telse\n\t\t\tlocal position = instance.Position\n\t\t\tif not finite(position.X) or not finite(position.Y) or not finite(position.Z) then fail(\"non-finite BasePart position\") return end\n\t\t\ttable.insert(results, { id = call.id, capability = \"base_part.position\", targetId = call.targetId, status = \"ok\", position = vector(position), elapsedMs = math.floor((os.clock() - started) * 1000) })\n\t\tend\nelseif call.capability == \"base_part.position_series\" then\n\t\tlocal instance = resolved[call.targetId]\n\t\tif not string.match(target.path, \"^Workspace/\") or target.expectedClass ~= \"BasePart\" or not instance or not instance:IsA(\"BasePart\") then\n\t\t\ttable.insert(results, { id = call.id, capability = \"base_part.position_series\", targetId = call.targetId, status = \"unavailable\" })\n\t\telse\n\t\t\tif typeof(call.sampleCount) ~= \"number\" or typeof(call.intervalMs) ~= \"number\" or call.sampleCount < 1 or call.sampleCount > 32 or call.intervalMs < 100 or call.intervalMs > 1000 then fail(\"series capability bounds rejected\") return end\n\t\t\tlocal samples = {}\n\t\t\tfor sequence = 1, call.sampleCount do\n\t\t\t\tlocal position = instance.Position\n\t\t\t\tif not finite(position.X) or not finite(position.Y) or not finite(position.Z) then fail(\"non-finite BasePart position\") return end\n\t\t\t\ttable.insert(samples, { sequence = sequence, elapsedMs = math.floor((os.clock() - started) * 1000), position = vector(position) })\n\t\t\t\tif sequence < call.sampleCount then task.wait(call.intervalMs / 1000) end\n\t\t\tend\n\t\t\ttable.insert(results, { id = call.id, capability = \"base_part.position_series\", targetId = call.targetId, status = \"ok\", samples = samples })\n\t\tend\nelseif call.capability == \"instance.property\" then\n\t\tlocal instance = resolved[call.targetId]\n\t\tlocal property = typeof(call.propertyName) == \"string\" and Generated.propertyMetadata(instance and instance.ClassName, call.propertyName) or nil\n\t\tif not instance or not property or property.codec == \"instance_ref\" then\n\t\t\ttable.insert(results, { id = call.id, capability = \"instance.property\", targetId = call.targetId, propertyName = call.propertyName, status = \"unavailable\" })\n\t\telse\n\t\t\tlocal ok, value = pcall(function() return Generated.read(instance, call.propertyName) end)\n\t\t\tif not ok then fail(\"manifest property read failed\") return end\n\t\t\ttable.insert(results, { id = call.id, capability = \"instance.property\", targetId = call.targetId, propertyName = call.propertyName, status = \"ok\", value = value, elapsedMs = math.floor((os.clock() - started) * 1000) })\n\t\tend\nelseif call.capability == \"instance.property_series\" then\n\t\tlocal instance = resolved[call.targetId]\n\t\tlocal property = typeof(call.propertyName) == \"string\" and Generated.propertyMetadata(instance and instance.ClassName, call.propertyName) or nil\n\t\tif not instance or not property or property.codec == \"instance_ref\" then\n\t\t\ttable.insert(results, { id = call.id, capability = \"instance.property_series\", targetId = call.targetId, propertyName = call.propertyName, status = \"unavailable\" })\n\t\telse\n\t\t\tif typeof(call.sampleCount) ~= \"number\" or typeof(call.intervalMs) ~= \"number\" or call.sampleCount < 1 or call.sampleCount > 32 or call.intervalMs < 100 or call.intervalMs > 1000 then fail(\"manifest property series bounds rejected\") return end\n\t\t\tlocal samples = {}\n\t\t\tfor sequence = 1, call.sampleCount do\n\t\t\t\tlocal ok, value = pcall(function() return Generated.read(instance, call.propertyName) end)\n\t\t\t\tif not ok then fail(\"manifest property series read failed\") return end\n\t\t\t\ttable.insert(samples, { sequence = sequence, elapsedMs = math.floor((os.clock() - started) * 1000), value = value })\n\t\t\t\tif sequence < call.sampleCount then task.wait(call.intervalMs / 1000) end\n\t\t\tend\n\t\t\ttable.insert(results, { id = call.id, capability = \"instance.property_series\", targetId = call.targetId, propertyName = call.propertyName, status = \"ok\", samples = samples })\n\t\tend\nelseif call.capability == \"instance.resolve\" then\n\t\tlocal instance = resolutionTarget(target.path)\n\t\tif not instance then\n\t\t\ttable.insert(results, { id = call.id, capability = \"instance.resolve\", targetId = call.targetId, status = \"missing\" })\n\t\telseif not instance:IsA(target.expectedClass) then\n\t\t\ttable.insert(results, { id = call.id, capability = \"instance.resolve\", targetId = call.targetId, status = \"class_mismatch\", path = target.path, className = instance.ClassName })\n\t\telse\n\t\t\tresolved[call.targetId] = instance\n\t\t\ttable.insert(results, { id = call.id, capability = \"instance.resolve\", targetId = call.targetId, status = \"resolved\", path = target.path, className = instance.ClassName })\n\t\tend\n\telse\n\t\tfail(\"capability is not allowlisted\") return\n\tend"
Generated.vectors = {
	{ ["name"] = "boolean_false", ["value"] = { ["kind"] = "boolean", ["value"] = false }, ["material"] = "12:studio-value26:5:codec7:boolean5:value1:0" },
	{ ["name"] = "number_f32_negative_zero", ["value"] = { ["kind"] = "number_f32", ["value"] = -0 }, ["material"] = "12:studio-value36:5:codec10:number_f324:bits8:80000000" },
	{ ["name"] = "number_f32_rounding", ["value"] = { ["kind"] = "number_f32", ["value"] = 0.3333333432674408 }, ["material"] = "12:studio-value36:5:codec10:number_f324:bits8:3eaaaaab" },
	{ ["name"] = "number_f64_negative_zero", ["value"] = { ["kind"] = "number_f64", ["value"] = -0 }, ["material"] = "12:studio-value45:5:codec10:number_f644:bits16:8000000000000000" },
	{ ["name"] = "int32_minimum", ["value"] = { ["kind"] = "int32", ["value"] = -2147483648 }, ["material"] = "12:studio-value35:5:codec5:int325:value11:-2147483648" },
	{ ["name"] = "int64_decimal_maximum_exact", ["value"] = { ["kind"] = "int64_decimal", ["value"] = "9007199254740991" }, ["material"] = "12:studio-value51:5:codec13:int64_decimal7:decimal16:9007199254740991" },
	{ ["name"] = "content", ["value"] = { ["kind"] = "content", ["value"] = "rbxassetid://12345" }, ["material"] = "12:studio-value43:5:codec7:content4:utf818:rbxassetid://12345" },
	{ ["name"] = "rgb8", ["value"] = { ["kind"] = "color3_rgb8", ["r"] = 12, ["g"] = 128, ["b"] = 255 }, ["material"] = "12:studio-value44:5:codec11:color3_rgb81:r2:121:g3:1281:b3:255" },
	{ ["name"] = "vector2", ["value"] = { ["kind"] = "vector2_f32", ["x"] = -1.25, ["y"] = 99.5 }, ["material"] = "12:studio-value47:5:codec11:vector2_f321:x8:bfa000001:y8:42c70000" },
	{ ["name"] = "vector3", ["value"] = { ["kind"] = "vector3_f32", ["x"] = -1.25, ["y"] = 0, ["z"] = 99.5 }, ["material"] = "12:studio-value60:5:codec11:vector3_f321:x8:bfa000001:y8:000000001:z8:42c70000" },
	{ ["name"] = "cframe", ["value"] = { ["kind"] = "cframe_f32x12", ["components"] = { 1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1 } }, ["material"] = "12:studio-value161:5:codec13:cframe_f32x1210:components121:8:sequence107:5:count2:123f80000040000000404000003f8000000000000000000000000000003f8000000000000000000000000000003f800000" },
	{ ["name"] = "udim", ["value"] = { ["kind"] = "udim", ["scale"] = 0.25, ["offset"] = -12 }, ["material"] = "12:studio-value52:5:codec4:udim4:udim30:5:scale8:3e8000006:offset3:-12" },
	{ ["name"] = "udim2", ["value"] = { ["kind"] = "udim2", ["x"] = { ["scale"] = 0.25, ["offset"] = -12 }, ["y"] = { ["scale"] = 0.75, ["offset"] = 48 } }, ["material"] = "12:studio-value103:5:codec5:udim21:x39:4:udim30:5:scale8:3e8000006:offset3:-121:y38:4:udim29:5:scale8:3f4000006:offset2:48" },
	{ ["name"] = "rect", ["value"] = { ["kind"] = "rect", ["minX"] = -2, ["minY"] = -1, ["maxX"] = 3, ["maxY"] = 4 }, ["material"] = "12:studio-value81:5:codec4:rect5:min-x8:c00000005:min-y8:bf8000005:max-x8:404000005:max-y8:40800000" },
	{ ["name"] = "number_range", ["value"] = { ["kind"] = "number_range", ["min"] = -1.5, ["max"] = 2.5 }, ["material"] = "12:studio-value52:5:codec12:number_range3:min8:bfc000003:max8:40200000" },
	{ ["name"] = "number_sequence", ["value"] = { ["kind"] = "number_sequence", ["keypoints"] = { { ["time"] = 0, ["value"] = 0, ["envelope"] = 0 }, { ["time"] = 0.5, ["value"] = 0.75, ["envelope"] = 0.125 }, { ["time"] = 1, ["value"] = 1, ["envelope"] = 0 } } }, ["material"] = "12:studio-value262:5:codec15:number_sequence9:keypoints222:8:sequence208:5:count1:38:keypoint53:4:time8:000000005:value8:000000008:envelope8:000000008:keypoint53:4:time8:3f0000005:value8:3f4000008:envelope8:3e0000008:keypoint53:4:time8:3f8000005:value8:3f8000008:envelope8:00000000" },
	{ ["name"] = "color_sequence", ["value"] = { ["kind"] = "color_sequence", ["keypoints"] = { { ["time"] = 0, ["color"] = { ["r"] = 0, ["g"] = 12, ["b"] = 255 } }, { ["time"] = 1, ["color"] = { ["r"] = 255, ["g"] = 128, ["b"] = 0 } } } }, ["material"] = "12:studio-value204:5:codec14:color_sequence9:keypoints165:8:sequence151:5:count1:28:keypoint57:4:time8:000000005:color31:5:color21:1:r1:01:g2:121:b3:2558:keypoint58:4:time8:3f8000005:color32:5:color22:1:r3:2551:g3:1281:b1:0" },
	{ ["name"] = "brick_color", ["value"] = { ["kind"] = "brick_color", ["name"] = "Really red" }, ["material"] = "12:studio-value40:5:codec11:brick_color4:name10:Really red" },
	{ ["name"] = "font", ["value"] = { ["kind"] = "font", ["family"] = "rbxasset://fonts/families/Arial.json", ["weight"] = "Regular", ["style"] = "Normal" }, ["material"] = "12:studio-value92:5:codec4:font6:family36:rbxasset://fonts/families/Arial.json6:weight7:Regular5:style6:Normal" },
	{ ["name"] = "physical_properties", ["value"] = { ["kind"] = "physical_properties", ["density"] = 0.699999988079071, ["friction"] = 0.25, ["elasticity"] = 0.5, ["frictionWeight"] = 0.75, ["elasticityWeight"] = 1 }, ["material"] = "12:studio-value149:5:codec19:physical_properties7:density8:3f3333338:friction8:3e80000010:elasticity8:3f00000015:friction-weight8:3f40000017:elasticity-weight8:3f800000" },
	{ ["name"] = "axes", ["value"] = { ["kind"] = "axes", ["x"] = true, ["y"] = false, ["z"] = true }, ["material"] = "12:studio-value31:5:codec4:axes1:x1:11:y1:01:z1:1" },
	{ ["name"] = "faces", ["value"] = { ["kind"] = "faces", ["top"] = true, ["bottom"] = false, ["left"] = true, ["right"] = false, ["front"] = true, ["back"] = false }, ["material"] = "12:studio-value71:5:codec5:faces3:top1:16:bottom1:04:left1:15:right1:05:front1:14:back1:0" },
	{ ["name"] = "ray", ["value"] = { ["kind"] = "ray", ["origin"] = { ["x"] = -1, ["y"] = 2, ["z"] = -3 }, ["direction"] = { ["x"] = 4, ["y"] = 5, ["z"] = 6 } }, ["material"] = "12:studio-value139:5:codec3:ray6:origin51:7:vector339:1:x8:bf8000001:y8:400000001:z8:c04000009:direction51:7:vector339:1:x8:408000001:y8:40a000001:z8:40c00000" },
	{ ["name"] = "instance_ref_nil", ["value"] = { ["kind"] = "instance_ref", ["state"] = "nil", ["expectedClass"] = "BasePart" }, ["material"] = "12:studio-value61:5:codec12:instance_ref5:state3:nil14:expected-class8:BasePart" },
	{ ["name"] = "instance_ref", ["value"] = { ["kind"] = "instance_ref", ["state"] = "reference", ["stableId"] = "reference-1", ["path"] = "Workspace/Reference", ["className"] = "Part", ["expectedClass"] = "BasePart" }, ["material"] = "12:studio-value133:5:codec12:instance_ref5:state9:reference9:stable-id11:reference-14:path19:Workspace/Reference5:class4:Part14:expected-class8:BasePart" },
	{ ["name"] = "enum", ["value"] = { ["kind"] = "enum_name", ["value"] = "SmoothPlastic" }, ["material"] = "12:studio-value40:5:codec9:enum_name4:name13:SmoothPlastic" },
	{ ["name"] = "utf8", ["value"] = { ["kind"] = "string_utf8", ["value"] = "forge-✓" }, ["material"] = "12:studio-value38:5:codec11:string_utf84:utf89:forge-✓" },
}

local function finite(value: any): boolean
	return typeof(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end
-- Keep value canonicalization usable in the Luau CLI module tests. Roblox's
-- script tree is touched only when a SHA-256 identity is actually needed.
local function sha256(value: string): string
	local Hash = if script ~= nil then require(script.Parent.Hash) else require("./Hash")
	return Hash.sha256(value)
end
local function validUtf8(value: any): boolean
	if typeof(value) ~= "string" then return false end
	local ok, length = pcall(function() return utf8.len(value) end)
	return ok and length ~= nil
end
local function exactKeys(value: any, expected: {string})
	if typeof(value) ~= "table" then error("expected table") end
	local count = 0
	for key in pairs(value) do
		if typeof(key) ~= "string" then error("unexpected non-string field") end
		count += 1
		local found = false
		for _, name in ipairs(expected) do if key == name then found = true; break end end
		if not found then error("unexpected field " .. key) end
	end
	if count ~= #expected then error("missing field") end
end
local function sequence(value: any, label: string)
	if typeof(value) ~= "table" then error(label .. " must be a sequence") end
	for key in pairs(value) do if typeof(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > #value then error(label .. " has an unexpected field") end end
end
local function f32(value: number): number
	if not finite(value) then error("non-finite float32") end
	local packed = string.pack(">f", value)
	local result: any = string.unpack(">f", packed)
	if not finite(result) then error("float32 overflow") end
	return result :: number
end
local function hex(bytes: string): string
	local result = {} :: {string}
	for index = 1, #bytes do table.insert(result, string.format("%02x", string.byte(bytes, index))) end
	return table.concat(result)
end
local function tagged(tag: string, payload: string): string
	return tostring(#tag) .. ":" .. tag .. tostring(#payload) .. ":" .. payload
end
local function taggedSequence(parts: {string}): string
	local payload = tagged("count", tostring(#parts))
	for _, part in ipairs(parts) do payload ..= part end
	return tagged("sequence", payload)
end
local function valueKind(value: any): string
	if typeof(value) ~= "table" or typeof(value.kind) ~= "string" then error("Studio value requires a kind") end
	return value.kind
end

function Generated.isAllowedRoot(path: any): boolean
	if typeof(path) ~= "string" then return false end
	for _, root in ipairs(Generated.authoringRoots) do if path == root or string.sub(path, 1, #root + 1) == root .. "/" then return true end end
	return false
end
function Generated.classMetadata(className: any): any
	if typeof(className) ~= "string" then return nil end
	return Generated.classes[className]
end
function Generated.propertyMetadata(className: any, propertyName: any): any
	local class = Generated.classMetadata(className)
	if class == nil or typeof(propertyName) ~= "string" then return nil end
	return class.properties[propertyName]
end
function Generated.runtimeCapabilityMetadata(name: any): any
	if typeof(name) ~= "string" then return nil end
	return Generated.runtimeCapabilities[name]
end
-- The trusted Play-Solo runner dispatches on a manifest result domain, never
-- on a second handwritten capability-name list.  Handlers receive the exact
-- generated metadata and opaque runner context.
function Generated.runtimeDispatch(capability: any, handlers: any, context: any): any
	local metadata = Generated.runtimeCapabilityMetadata(capability)
	if metadata == nil or typeof(handlers) ~= "table" then error("runtime capability outside manifest") end
	local handler = handlers[metadata.result]
	if typeof(handler) ~= "function" then error("runtime result handler outside manifest") end
	return handler(metadata, context)
end
local function rgb(value: any, label: string): any
	if typeof(value) ~= "table" then error(label) end
	exactKeys(value, { "r", "g", "b" })
	for _, channel in ipairs({ value.r, value.g, value.b }) do if typeof(channel) ~= "number" or channel % 1 ~= 0 or channel < 0 or channel > 255 then error(label) end end
	return { r = value.r, g = value.g, b = value.b }
end
local function vector2(value: any, label: string): any
	if typeof(value) ~= "table" then error(label) end
	exactKeys(value, { "x", "y" }); return { x = f32(value.x), y = f32(value.y) }
end
local function vector3(value: any, label: string): any
	if typeof(value) ~= "table" then error(label) end
	exactKeys(value, { "x", "y", "z" }); return { x = f32(value.x), y = f32(value.y), z = f32(value.z) }
end
local function udim(value: any, label: string): any
	if typeof(value) ~= "table" then error(label) end
	exactKeys(value, { "scale", "offset" })
	if typeof(value.offset) ~= "number" or value.offset % 1 ~= 0 or value.offset < -2147483648 or value.offset > 2147483647 then error(label) end
	return { scale = f32(value.scale), offset = value.offset }
end
local function int64Decimal(value: any): string
	if typeof(value) ~= "string" or not string.match(value, "^-?%d+$") or value == "-0" or string.match(value, "^-?0%d") then error("invalid int64 decimal") end
	local negative = string.sub(value, 1, 1) == "-"; local digits = negative and string.sub(value, 2) or value
	if #digits > 16 or #digits == 16 and digits > "9007199254740991" then error("int64 decimal is not exactly representable by Luau") end
	return value
end
local function valueNumbers(value: any): {number}
	if value.kind == "number_f32" or value.kind == "number_f64" or value.kind == "int32" then return { value.value } end
	if value.kind == "vector2_f32" then return { value.x, value.y } end
	if value.kind == "vector3_f32" then return { value.x, value.y, value.z } end
	if value.kind == "cframe_f32x12" then return value.components end
	if value.kind == "udim" then return { value.scale, value.offset } end
	if value.kind == "udim2" then return { value.x.scale, value.x.offset, value.y.scale, value.y.offset } end
	if value.kind == "rect" then return { value.minX, value.minY, value.maxX, value.maxY } end
	if value.kind == "number_range" then return { value.min, value.max } end
	if value.kind == "number_sequence" then local result = {}; for _, item in ipairs(value.keypoints) do table.insert(result, item.time); table.insert(result, item.value); table.insert(result, item.envelope) end; return result end
	if value.kind == "color_sequence" then local result = {}; for _, item in ipairs(value.keypoints) do table.insert(result, item.time); table.insert(result, item.color.r); table.insert(result, item.color.g); table.insert(result, item.color.b) end; return result end
	if value.kind == "physical_properties" then return { value.density, value.friction, value.elasticity, value.frictionWeight, value.elasticityWeight } end
	if value.kind == "ray" then return { value.origin.x, value.origin.y, value.origin.z, value.direction.x, value.direction.y, value.direction.z } end
	return {}
end
local function keypoints(value: any, kind: string, maximumEntries: any): any
	sequence(value, kind .. " keypoints"); if #value < 2 or maximumEntries ~= nil and #value > maximumEntries then error(kind .. " keypoint bound") end
	local previous = -1; local output = {}
	for index, raw in ipairs(value) do
		if typeof(raw) ~= "table" then error(kind .. " keypoint") end
		if kind == "number_sequence" then
			exactKeys(raw, { "time", "value", "envelope" }); local time, itemValue, envelope = f32(raw.time), f32(raw.value), f32(raw.envelope)
			if time < 0 or time > 1 or time <= previous or envelope < 0 then error(kind .. " keypoint") end
			output[index] = { time = time, value = itemValue, envelope = envelope }
		else
			exactKeys(raw, { "time", "color" }); local time = f32(raw.time); if time < 0 or time > 1 or time <= previous then error(kind .. " keypoint") end
			output[index] = { time = time, color = rgb(raw.color, kind .. " color") }
		end
		previous = output[index].time
	end
	if output[1].time ~= 0 or output[#output].time ~= 1 then error(kind .. " endpoints") end
	return output
end
function Generated.canonicalValue(value: any, property: any?): any
	local kind = valueKind(value)
	if kind == "boolean" then exactKeys(value, { "kind", "value" }); if typeof(value.value) ~= "boolean" then error("invalid boolean") end; return { kind = kind, value = value.value } end
	if kind == "number_f32" then exactKeys(value, { "kind", "value" }); return { kind = kind, value = f32(value.value) } end
	if kind == "number_f64" then exactKeys(value, { "kind", "value" }); if not finite(value.value) then error("invalid float64") end; return { kind = kind, value = value.value } end
	if kind == "int32" then exactKeys(value, { "kind", "value" }); if typeof(value.value) ~= "number" or value.value % 1 ~= 0 or value.value < -2147483648 or value.value > 2147483647 then error("invalid int32") end; return { kind = kind, value = value.value } end
	if kind == "int64_decimal" then exactKeys(value, { "kind", "value" }); return { kind = kind, value = int64Decimal(value.value) } end
	if kind == "string_utf8" or kind == "content" then exactKeys(value, { "kind", "value" }); if not validUtf8(value.value) or kind == "content" and value.value == "" then error("invalid UTF-8") end; if property and property.maximumUtf8Bytes and #value.value > property.maximumUtf8Bytes then error("string bound") end; return { kind = kind, value = value.value } end
	if kind == "color3_rgb8" then exactKeys(value, { "kind", "r", "g", "b" }); local color = rgb({ r = value.r, g = value.g, b = value.b }, "invalid RGB8"); return { kind = kind, r = color.r, g = color.g, b = color.b } end
	if kind == "vector2_f32" then exactKeys(value, { "kind", "x", "y" }); local vector = vector2({ x = value.x, y = value.y }, "invalid Vector2"); return { kind = kind, x = vector.x, y = vector.y } end
	if kind == "vector3_f32" then exactKeys(value, { "kind", "x", "y", "z" }); local vector = vector3({ x = value.x, y = value.y, z = value.z }, "invalid Vector3"); return { kind = kind, x = vector.x, y = vector.y, z = vector.z } end
	if kind == "cframe_f32x12" then exactKeys(value, { "kind", "components" }); sequence(value.components, "CFrame components"); if #value.components ~= 12 then error("CFrame requires 12 components") end; local components = {}; for index, component in ipairs(value.components) do components[index] = f32(component) end; if property and property.maximumAbsoluteTranslation then for index = 1, 3 do if math.abs(components[index]) > property.maximumAbsoluteTranslation then error("CFrame translation bound") end end end; return { kind = kind, components = components } end
	if kind == "udim" then exactKeys(value, { "kind", "scale", "offset" }); local item = udim({ scale = value.scale, offset = value.offset }, "invalid UDim"); return { kind = kind, scale = item.scale, offset = item.offset } end
	if kind == "udim2" then exactKeys(value, { "kind", "x", "y" }); return { kind = kind, x = udim(value.x, "invalid UDim2 x"), y = udim(value.y, "invalid UDim2 y") } end
	if kind == "rect" then exactKeys(value, { "kind", "minX", "minY", "maxX", "maxY" }); local minX, minY, maxX, maxY = f32(value.minX), f32(value.minY), f32(value.maxX), f32(value.maxY); if minX > maxX or minY > maxY then error("invalid Rect") end; return { kind = kind, minX = minX, minY = minY, maxX = maxX, maxY = maxY } end
	if kind == "number_range" then exactKeys(value, { "kind", "min", "max" }); local min, max = f32(value.min), f32(value.max); if min > max then error("invalid NumberRange") end; return { kind = kind, min = min, max = max } end
	if kind == "number_sequence" or kind == "color_sequence" then exactKeys(value, { "kind", "keypoints" }); return { kind = kind, keypoints = keypoints(value.keypoints, kind, property and property.maximumEntries) } end
	if kind == "brick_color" then exactKeys(value, { "kind", "name" }); if not validUtf8(value.name) or value.name == "" then error("invalid BrickColor") end; if property and property.allowed then local found = false; for _, name in ipairs(property.allowed) do if name == value.name then found = true end end; if not found then error("BrickColor not allowlisted") end end; return { kind = kind, name = value.name } end
	if kind == "font" then exactKeys(value, { "kind", "family", "weight", "style" }); for _, item in ipairs({ value.family, value.weight, value.style }) do if not validUtf8(item) or item == "" then error("invalid Font") end end; return { kind = kind, family = value.family, weight = value.weight, style = value.style } end
	if kind == "physical_properties" then exactKeys(value, { "kind", "density", "friction", "elasticity", "frictionWeight", "elasticityWeight" }); local density, friction, elasticity, frictionWeight, elasticityWeight = f32(value.density), f32(value.friction), f32(value.elasticity), f32(value.frictionWeight), f32(value.elasticityWeight); if density <= 0 or friction < 0 or friction > 1 or elasticity < 0 or elasticity > 1 or frictionWeight < 0 or frictionWeight > 1 or elasticityWeight < 0 or elasticityWeight > 1 then error("invalid PhysicalProperties") end; return { kind = kind, density = density, friction = friction, elasticity = elasticity, frictionWeight = frictionWeight, elasticityWeight = elasticityWeight } end
	if kind == "axes" then exactKeys(value, { "kind", "x", "y", "z" }); for _, item in ipairs({ value.x, value.y, value.z }) do if typeof(item) ~= "boolean" then error("invalid Axes") end end; return { kind = kind, x = value.x, y = value.y, z = value.z } end
	if kind == "faces" then exactKeys(value, { "kind", "top", "bottom", "left", "right", "front", "back" }); for _, item in ipairs({ value.top, value.bottom, value.left, value.right, value.front, value.back }) do if typeof(item) ~= "boolean" then error("invalid Faces") end end; return { kind = kind, top = value.top, bottom = value.bottom, left = value.left, right = value.right, front = value.front, back = value.back } end
	if kind == "ray" then exactKeys(value, { "kind", "origin", "direction" }); return { kind = kind, origin = vector3(value.origin, "invalid Ray origin"), direction = vector3(value.direction, "invalid Ray direction") } end
	if kind == "instance_ref" then
		if value.state == "nil" then exactKeys(value, { "kind", "state", "expectedClass" }); if not validUtf8(value.expectedClass) or value.expectedClass == "" or property and property.referenceClass ~= value.expectedClass then error("nil Instance reference class constraint") end; return { kind = kind, state = "nil", expectedClass = value.expectedClass } end
		exactKeys(value, { "kind", "state", "stableId", "path", "className", "expectedClass" }); if value.state ~= "reference" then error("invalid Instance reference state") end; for _, item in ipairs({ value.stableId, value.path, value.className, value.expectedClass }) do if typeof(item) ~= "string" or item == "" or not validUtf8(item) then error("invalid Instance reference") end end; if string.sub(value.path, 1, 1) == "/" or string.sub(value.path, -1) == "/" or string.find(value.path, "\\", 1, true) then error("invalid Instance reference path") end; for _, part in ipairs(string.split(value.path, "/")) do if part == "" or part == "." or part == ".." then error("invalid Instance reference path") end end; if property and property.referenceClass ~= value.expectedClass then error("Instance reference class constraint") end; return { kind = kind, state = "reference", stableId = value.stableId, path = value.path, className = value.className, expectedClass = value.expectedClass } end
	if kind == "enum_name" then exactKeys(value, { "kind", "value" }); if not validUtf8(value.value) or value.value == "" then error("invalid enum") end; if property and property.allowed then local allowed = false; for _, name in ipairs(property.allowed) do if name == value.value then allowed = true end end; if not allowed then error("enum not allowlisted") end end; return { kind = kind, value = value.value } end
	error("unknown Studio value codec")
end
function Generated.validateValue(codec: any, value: any, property: any?): any
	local canonical = Generated.canonicalValue(value, property)
	if canonical.kind ~= codec then error("Studio value codec mismatch") end
	if property then for _, number in ipairs(valueNumbers(canonical)) do if property.minimum ~= nil and number < property.minimum then error("number minimum") end; if property.minimumExclusive ~= nil and number <= property.minimumExclusive then error("number exclusive minimum") end; if property.maximum ~= nil and number > property.maximum then error("number maximum") end end end
	return canonical
end
function Generated.toStudio(codec: any, value: any, property: any?, referenceResolver: any?): any
	local canonical = Generated.validateValue(codec, value, property)
	if codec == "boolean" or codec == "number_f32" or codec == "number_f64" or codec == "int32" or codec == "string_utf8" or codec == "content" then return canonical.value end
	if codec == "int64_decimal" then local number = tonumber(canonical.value); if number == nil or number % 1 ~= 0 or math.abs(number) > 9007199254740991 then error("int64 is not exactly representable by Luau") end; return number end
	if codec == "color3_rgb8" then return Color3.fromRGB(canonical.r, canonical.g, canonical.b) end
	if codec == "vector2_f32" then return Vector2.new(canonical.x, canonical.y) end
	if codec == "vector3_f32" then return Vector3.new(canonical.x, canonical.y, canonical.z) end
	if codec == "cframe_f32x12" then return CFrame.new(table.unpack(canonical.components)) end
	if codec == "udim" then return UDim.new(canonical.scale, canonical.offset) end
	if codec == "udim2" then return UDim2.new(canonical.x.scale, canonical.x.offset, canonical.y.scale, canonical.y.offset) end
	if codec == "rect" then return Rect.new(canonical.minX, canonical.minY, canonical.maxX, canonical.maxY) end
	if codec == "number_range" then return NumberRange.new(canonical.min, canonical.max) end
	if codec == "number_sequence" then local points = {}; for index, item in ipairs(canonical.keypoints) do points[index] = NumberSequenceKeypoint.new(item.time, item.value, item.envelope) end; return NumberSequence.new(points) end
	if codec == "color_sequence" then local points = {}; for index, item in ipairs(canonical.keypoints) do points[index] = ColorSequenceKeypoint.new(item.time, Color3.fromRGB(item.color.r, item.color.g, item.color.b)) end; return ColorSequence.new(points) end
	if codec == "brick_color" then return BrickColor.new(canonical.name) end
	if codec == "font" then local weight, style = (Enum.FontWeight :: any)[canonical.weight], (Enum.FontStyle :: any)[canonical.style]; if weight == nil or style == nil then error("Font enum unavailable") end; return Font.new(canonical.family, weight, style) end
	if codec == "physical_properties" then return PhysicalProperties.new(canonical.density, canonical.friction, canonical.elasticity, canonical.frictionWeight, canonical.elasticityWeight) end
	if codec == "axes" then local values = {}; if canonical.x then table.insert(values, Enum.Axis.X) end; if canonical.y then table.insert(values, Enum.Axis.Y) end; if canonical.z then table.insert(values, Enum.Axis.Z) end; return Axes.new(table.unpack(values)) end
	if codec == "faces" then local values = {}; if canonical.top then table.insert(values, Enum.NormalId.Top) end; if canonical.bottom then table.insert(values, Enum.NormalId.Bottom) end; if canonical.left then table.insert(values, Enum.NormalId.Left) end; if canonical.right then table.insert(values, Enum.NormalId.Right) end; if canonical.front then table.insert(values, Enum.NormalId.Front) end; if canonical.back then table.insert(values, Enum.NormalId.Back) end; return Faces.new(table.unpack(values)) end
	if codec == "ray" then return Ray.new(Vector3.new(canonical.origin.x, canonical.origin.y, canonical.origin.z), Vector3.new(canonical.direction.x, canonical.direction.y, canonical.direction.z)) end
	if codec == "instance_ref" then if canonical.state == "nil" then return nil end; if typeof(referenceResolver) ~= "function" then error("Instance reference resolver unavailable") end; local instance = referenceResolver(canonical); if typeof(instance) ~= "Instance" or not instance:IsA(canonical.expectedClass) or instance.ClassName ~= canonical.className then error("Instance reference precondition mismatch") end; return instance end
	if codec == "enum_name" then if property == nil or typeof(property.catalogType) ~= "table" or property.catalogType.category ~= "enum" or typeof(property.catalogType.name) ~= "string" then error("enum manifest metadata missing") end; local enumType = (Enum :: any)[property.catalogType.name]; local item = enumType and enumType[canonical.value]; if item == nil then error("enum unavailable") end; return item end
	error("unknown Studio value codec")
end
function Generated.fromStudio(codec: any, value: any, referenceEncoder: any?, property: any?): any
	if codec == "boolean" or codec == "number_f32" or codec == "number_f64" or codec == "int32" or codec == "string_utf8" or codec == "content" then return Generated.canonicalValue({ kind = codec, value = value }) end
	if codec == "int64_decimal" then if typeof(value) ~= "number" or value % 1 ~= 0 or math.abs(value) > 9007199254740991 then error("int64 readback is not exactly representable by Luau") end; return Generated.canonicalValue({ kind = codec, value = string.format("%.0f", value) }) end
	if codec == "color3_rgb8" then return Generated.canonicalValue({ kind = codec, r = math.floor(value.R * 255 + 0.5), g = math.floor(value.G * 255 + 0.5), b = math.floor(value.B * 255 + 0.5) }) end
	if codec == "vector2_f32" then return Generated.canonicalValue({ kind = codec, x = value.X, y = value.Y }) end
	if codec == "vector3_f32" then return Generated.canonicalValue({ kind = codec, x = value.X, y = value.Y, z = value.Z }) end
	if codec == "cframe_f32x12" then return Generated.canonicalValue({ kind = codec, components = { value:GetComponents() } }) end
	if codec == "udim" then return Generated.canonicalValue({ kind = codec, scale = value.Scale, offset = value.Offset }) end
	if codec == "udim2" then return Generated.canonicalValue({ kind = codec, x = { scale = value.X.Scale, offset = value.X.Offset }, y = { scale = value.Y.Scale, offset = value.Y.Offset } }) end
	if codec == "rect" then return Generated.canonicalValue({ kind = codec, minX = value.Min.X, minY = value.Min.Y, maxX = value.Max.X, maxY = value.Max.Y }) end
	if codec == "number_range" then return Generated.canonicalValue({ kind = codec, min = value.Min, max = value.Max }) end
	if codec == "number_sequence" then local points = {}; for index, item in ipairs(value.Keypoints) do points[index] = { time = item.Time, value = item.Value, envelope = item.Envelope } end; return Generated.canonicalValue({ kind = codec, keypoints = points }) end
	if codec == "color_sequence" then local points = {}; for index, item in ipairs(value.Keypoints) do points[index] = { time = item.Time, color = { r = math.floor(item.Value.R * 255 + 0.5), g = math.floor(item.Value.G * 255 + 0.5), b = math.floor(item.Value.B * 255 + 0.5) } } end; return Generated.canonicalValue({ kind = codec, keypoints = points }) end
	if codec == "brick_color" then return Generated.canonicalValue({ kind = codec, name = value.Name }) end
	if codec == "font" then return Generated.canonicalValue({ kind = codec, family = value.Family, weight = value.Weight.Name, style = value.Style.Name }) end
	if codec == "physical_properties" then return Generated.canonicalValue({ kind = codec, density = value.Density, friction = value.Friction, elasticity = value.Elasticity, frictionWeight = value.FrictionWeight, elasticityWeight = value.ElasticityWeight }) end
	if codec == "axes" then return Generated.canonicalValue({ kind = codec, x = value.X, y = value.Y, z = value.Z }) end
	if codec == "faces" then return Generated.canonicalValue({ kind = codec, top = value.Top, bottom = value.Bottom, left = value.Left, right = value.Right, front = value.Front, back = value.Back }) end
	if codec == "ray" then return Generated.canonicalValue({ kind = codec, origin = { x = value.Origin.X, y = value.Origin.Y, z = value.Origin.Z }, direction = { x = value.Direction.X, y = value.Direction.Y, z = value.Direction.Z } }) end
	if codec == "instance_ref" then if value == nil then return Generated.canonicalValue({ kind = codec, state = "nil", expectedClass = property.referenceClass }, property) end; if typeof(referenceEncoder) ~= "function" then error("Instance reference encoder unavailable") end; return Generated.canonicalValue(referenceEncoder(value, property), property) end
	if codec == "enum_name" then return Generated.canonicalValue({ kind = codec, value = value.Name }) end
	error("unknown Studio value codec")
end
function Generated.write(instance: Instance, propertyName: string, value: any, referenceResolver: any?)
	local property = Generated.propertyMetadata(instance.ClassName, propertyName)
	if property == nil then error("property is not manifest writable") end
	(instance :: any)[propertyName] = Generated.toStudio(property.codec, value, property, referenceResolver)
end
function Generated.read(instance: Instance, propertyName: string, referenceEncoder: any?): any
	local property = Generated.propertyMetadata(instance.ClassName, propertyName)
	if property == nil then error("property is not manifest readable") end
	return Generated.validateValue(property.codec, Generated.fromStudio(property.codec, (instance :: any)[propertyName], referenceEncoder, property), property)
end
function Generated.canonicalAttribute(value: any): any
	if typeof(value) == "boolean" then return value end
	if typeof(value) == "number" then return f32(value) end
	if typeof(value) == "string" then
		if not validUtf8(value) or #value > Generated.manifest.attributes.maximumStringUtf8Bytes then error("attribute string outside manifest") end
		return value
	end
	error("attribute type outside manifest")
end
function Generated.validateAttributes(attributes: any)
	if typeof(attributes) ~= "table" then error("attributes must be a table") end
	local canonical = {}
	local count = 0
	for name, value in pairs(attributes) do
		count += 1
		if count > Generated.manifest.attributes.maximumCount or typeof(name) ~= "string" or #name == 0 or #name > Generated.manifest.attributes.maximumNameUtf8Bytes or string.sub(name, 1, #Generated.manifest.attributes.reservedPrefix) == Generated.manifest.attributes.reservedPrefix then error("attribute outside manifest") end
		canonical[name] = Generated.canonicalAttribute(value)
	end
	return canonical
end
function Generated.validateSource(source: any, required: boolean)
	if source == nil then if required then error("source required") end; return end
	if not validUtf8(source) or #source > Generated.manifest.source.maximumUtf8Bytes or required and not string.find(source, "%S") then error("source outside manifest") end
end
function Generated.canonicalValueMaterial(value: any): string
	local item = Generated.canonicalValue(value)
	if item.kind == "boolean" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("value", item.value and "1" or "0")) end
	if item.kind == "number_f32" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("bits", hex(string.pack(">f", item.value)))) end
	if item.kind == "number_f64" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("bits", hex(string.pack(">d", item.value)))) end
	if item.kind == "int32" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("value", tostring(item.value))) end
	if item.kind == "int64_decimal" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("decimal", item.value)) end
	if item.kind == "string_utf8" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("utf8", item.value)) end
	if item.kind == "content" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("utf8", item.value)) end
	if item.kind == "color3_rgb8" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("r", tostring(item.r)) .. tagged("g", tostring(item.g)) .. tagged("b", tostring(item.b))) end
	if item.kind == "vector2_f32" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("x", hex(string.pack(">f", item.x))) .. tagged("y", hex(string.pack(">f", item.y)))) end
	if item.kind == "vector3_f32" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("x", hex(string.pack(">f", item.x))) .. tagged("y", hex(string.pack(">f", item.y))) .. tagged("z", hex(string.pack(">f", item.z)))) end
	if item.kind == "cframe_f32x12" then local values = {}; for index, component in ipairs(item.components) do values[index] = hex(string.pack(">f", component)) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("components", taggedSequence(values))) end
	if item.kind == "udim" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("udim", tagged("scale", hex(string.pack(">f", item.scale))) .. tagged("offset", tostring(item.offset)))) end
	if item.kind == "udim2" then local function material(part) return tagged("udim", tagged("scale", hex(string.pack(">f", part.scale))) .. tagged("offset", tostring(part.offset))) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("x", material(item.x)) .. tagged("y", material(item.y))) end
	if item.kind == "rect" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("min-x", hex(string.pack(">f", item.minX))) .. tagged("min-y", hex(string.pack(">f", item.minY))) .. tagged("max-x", hex(string.pack(">f", item.maxX))) .. tagged("max-y", hex(string.pack(">f", item.maxY)))) end
	if item.kind == "number_range" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("min", hex(string.pack(">f", item.min))) .. tagged("max", hex(string.pack(">f", item.max)))) end
	if item.kind == "number_sequence" then local values = {}; for index, point in ipairs(item.keypoints) do values[index] = tagged("keypoint", tagged("time", hex(string.pack(">f", point.time))) .. tagged("value", hex(string.pack(">f", point.value))) .. tagged("envelope", hex(string.pack(">f", point.envelope)))) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("keypoints", taggedSequence(values))) end
	if item.kind == "color_sequence" then local values = {}; for index, point in ipairs(item.keypoints) do values[index] = tagged("keypoint", tagged("time", hex(string.pack(">f", point.time))) .. tagged("color", tagged("color", tagged("r", tostring(point.color.r)) .. tagged("g", tostring(point.color.g)) .. tagged("b", tostring(point.color.b))))) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("keypoints", taggedSequence(values))) end
	if item.kind == "brick_color" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("name", item.name)) end
	if item.kind == "font" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("family", item.family) .. tagged("weight", item.weight) .. tagged("style", item.style)) end
	if item.kind == "physical_properties" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("density", hex(string.pack(">f", item.density))) .. tagged("friction", hex(string.pack(">f", item.friction))) .. tagged("elasticity", hex(string.pack(">f", item.elasticity))) .. tagged("friction-weight", hex(string.pack(">f", item.frictionWeight))) .. tagged("elasticity-weight", hex(string.pack(">f", item.elasticityWeight)))) end
	if item.kind == "axes" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("x", item.x and "1" or "0") .. tagged("y", item.y and "1" or "0") .. tagged("z", item.z and "1" or "0")) end
	if item.kind == "faces" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("top", item.top and "1" or "0") .. tagged("bottom", item.bottom and "1" or "0") .. tagged("left", item.left and "1" or "0") .. tagged("right", item.right and "1" or "0") .. tagged("front", item.front and "1" or "0") .. tagged("back", item.back and "1" or "0")) end
	if item.kind == "ray" then local function vector(part) return tagged("vector3", tagged("x", hex(string.pack(">f", part.x))) .. tagged("y", hex(string.pack(">f", part.y))) .. tagged("z", hex(string.pack(">f", part.z)))) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("origin", vector(item.origin)) .. tagged("direction", vector(item.direction))) end
	if item.kind == "instance_ref" then if item.state == "nil" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("state", "nil") .. tagged("expected-class", item.expectedClass)) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("state", "reference") .. tagged("stable-id", item.stableId) .. tagged("path", item.path) .. tagged("class", item.className) .. tagged("expected-class", item.expectedClass)) end
	return tagged("studio-value", tagged("codec", item.kind) .. tagged("name", item.value))
end
local function dataMaterial(value: any): string
	if value == nil then return tagged("null", "") end
	if typeof(value) == "boolean" then return tagged("bool", value and "1" or "0") end
	if typeof(value) == "string" then if not validUtf8(value) then error("invalid UTF-8") end; return tagged("utf8", value) end
	if typeof(value) == "number" then if not finite(value) then error("non-finite number") end; return tagged("f64", hex(string.pack(">d", value))) end
	if typeof(value) ~= "table" then error("unsupported evidence value") end
	if typeof(value.kind) == "string" and (value.kind == "boolean" or value.kind == "number_f32" or value.kind == "number_f64" or value.kind == "int32" or value.kind == "int64_decimal" or value.kind == "string_utf8" or value.kind == "content" or value.kind == "color3_rgb8" or value.kind == "vector2_f32" or value.kind == "vector3_f32" or value.kind == "cframe_f32x12" or value.kind == "udim" or value.kind == "udim2" or value.kind == "rect" or value.kind == "number_range" or value.kind == "number_sequence" or value.kind == "color_sequence" or value.kind == "brick_color" or value.kind == "font" or value.kind == "physical_properties" or value.kind == "axes" or value.kind == "faces" or value.kind == "ray" or value.kind == "instance_ref" or value.kind == "enum_name") then return tagged("studio", Generated.canonicalValueMaterial(value)) end
	local length = #value
	-- HttpService encodes an empty evidence collection as a JSON array. Lua has
	-- no distinct empty-array type, so canonical evidence treats an empty table
	-- as that closed collection domain rather than the unused empty-object domain.
	local isSequence = length > 0 or next(value) == nil
	if isSequence then
		for key in pairs(value) do if typeof(key) ~= "number" or key < 1 or key > length or key % 1 ~= 0 then isSequence = false; break end end
	end
	if isSequence then local entries = {}; for index, entry in ipairs(value) do entries[index] = dataMaterial(entry) end; return tagged("array", taggedSequence(entries)) end
	local keys = {} :: {string}; for key in pairs(value) do if typeof(key) ~= "string" then error("evidence object key") end; table.insert(keys, key) end; table.sort(keys)
	local entries = {}; for index, key in ipairs(keys) do entries[index] = tagged("entry", tagged("key", key) .. tagged("value", dataMaterial(value[key]))) end
	return tagged("object", taggedSequence(entries))
end
local function targetMaterial(target: any): string
	if typeof(target) ~= "table" or typeof(target.kind) ~= "string" then error("invalid evidence target") end
	if target.kind == "project" then return tagged("target", "project") end
	if target.kind ~= "instance" or typeof(target.stableId) ~= "string" or typeof(target.path) ~= "string" or typeof(target.className) ~= "string" then error("invalid instance target") end
	return tagged("target", tagged("stable-id", target.stableId) .. tagged("path", target.path) .. tagged("class", target.className))
end
local function factResultMaterial(result: any): string
	if typeof(result) ~= "table" or typeof(result.status) ~= "string" then error("invalid fact result") end
	if result.status == "observed" then return tagged("result", tagged("status", result.status) .. tagged("value", dataMaterial(result.value))) end
	if result.status == "absent" then return tagged("result", tagged("status", result.status)) end
	if (result.status == "unavailable" or result.status == "read_error") and typeof(result.code) == "string" then return tagged("result", tagged("status", result.status) .. tagged("code", result.code)) end
	error("invalid fact result")
end
function Generated.factMaterial(fact: any): string
	if typeof(fact) ~= "table" or typeof(fact.kind) ~= "string" or typeof(fact.key) ~= "string" then error("invalid evidence fact") end
	local named = ""
	if fact.kind == "property" then named = tagged("property", fact.propertyName) elseif fact.kind == "attribute" then named = tagged("attribute", fact.attributeName) elseif fact.kind == "runtime_resolution" or fact.kind == "position_series" then named = tagged("runtime", tagged("call", fact.callId) .. tagged("target", fact.runtimeTargetId) .. tagged("capability", fact.capability)) elseif fact.kind == "position" and fact.callId ~= nil then named = tagged("runtime", tagged("call", fact.callId) .. tagged("target", fact.runtimeTargetId or "") .. tagged("capability", fact.capability or "")) end
	return tagged("StudioEvidenceFact", tagged("kind", fact.kind) .. tagged("key", fact.key) .. targetMaterial(fact.target) .. named .. factResultMaterial(fact.result))
end
function Generated.sortFacts(facts: any): {any}
	sequence(facts, "facts")
	local copy = table.clone(facts)
	table.sort(copy, function(left, right) return Generated.factMaterial(left) < Generated.factMaterial(right) end)
	local seen = {}; for _, fact in ipairs(copy) do if typeof(fact.key) ~= "string" or seen[fact.key] then error("duplicate or invalid evidence fact key") end; seen[fact.key] = true end
	return copy
end
function Generated.factKey(kind: string, target: any, name: string?): string
	if typeof(target) ~= "table" or typeof(target.kind) ~= "string" then error("invalid evidence target") end
	local identity = target.kind == "project" and "project" or tostring(target.stableId) .. "@" .. tostring(target.path) .. ":" .. tostring(target.className)
	if name == nil then return kind .. ":" .. identity end
	return kind .. ":" .. identity .. ":" .. name
end
local function bindingHash(binding: any): string
	if typeof(binding) ~= "table" then error("invalid evidence binding") end
	local names = {} :: {string}; for name, value in pairs(binding) do if typeof(name) ~= "string" or typeof(value) ~= "string" or value == "" then error("invalid evidence binding") end; table.insert(names, name) end; table.sort(names)
	local entries = {}; for index, name in ipairs(names) do entries[index] = tagged("entry", tagged("key", name) .. tagged("value", binding[name])) end
	return sha256(tagged("binding", taggedSequence(entries)))
end
local function projectMaterial(project: any): string
	if typeof(project) ~= "table" or typeof(project.name) ~= "string" or typeof(project.placeId) ~= "number" or typeof(project.universeId) ~= "number" then error("invalid project") end
	return tagged("project", tagged("name", project.name) .. tagged("place", tostring(project.placeId)) .. tagged("universe", tostring(project.universeId)))
end
local function requirementMaterial(requirement: any): string
	if typeof(requirement) ~= "table" or typeof(requirement.key) ~= "string" or typeof(requirement.kind) ~= "string" then error("invalid projection requirement") end
	return tagged("requirement", tagged("key", requirement.key) .. tagged("kind", requirement.kind) .. targetMaterial(requirement.target) .. tagged("property", requirement.propertyName or "") .. tagged("attribute", requirement.attributeName or "") .. tagged("call", requirement.callId or "") .. tagged("runtime-target", requirement.runtimeTargetId or "") .. tagged("capability", requirement.capability or "") .. tagged("expected-status", requirement.expectedStatus or "observed") .. tagged("expected", requirement.expected == nil and "" or dataMaterial(requirement.expected)))
end
local function scopeMaterial(scope: any): string
	if typeof(scope) ~= "table" or typeof(scope.mode) ~= "string" or typeof(scope.requireCompleteInventory) ~= "boolean" then error("invalid evidence scope") end
	sequence(scope.roots, "scope roots"); local roots = {}; for index, root in ipairs(scope.roots) do if typeof(root) ~= "string" then error("invalid scope root") end; roots[index] = tagged("root", root) end
	return tagged("scope", tagged("mode", scope.mode) .. tagged("roots", taggedSequence(roots)) .. tagged("inventory", scope.requireCompleteInventory and "1" or "0"))
end
local function boundsMaterial(bounds: any): string
	if typeof(bounds) ~= "table" or typeof(bounds.maximumFacts) ~= "number" or typeof(bounds.maximumBytes) ~= "number" then error("invalid evidence bounds") end
	sequence(bounds.roots, "bounds roots"); local roots = {}; for index, root in ipairs(bounds.roots) do if typeof(root) ~= "string" then error("invalid bound root") end; roots[index] = tagged("root", root) end
	return tagged("bounds", tagged("facts", tostring(bounds.maximumFacts)) .. tagged("bytes", tostring(bounds.maximumBytes)) .. tagged("roots", taggedSequence(roots)) .. tagged("instances", bounds.maximumInstances == nil and "" or tostring(bounds.maximumInstances)))
end
function Generated.bindingHash(binding: any): string return bindingHash(binding) end
function Generated.projectionMaterial(projection: any): string
	if typeof(projection) ~= "table" then error("invalid evidence projection") end
	sequence(projection.requirements, "projection requirements")
	local requirements = {}; for index, requirement in ipairs(projection.requirements) do requirements[index] = requirementMaterial(requirement) end
	local delta = {}; if projection.allowedStateDelta ~= nil then sequence(projection.allowedStateDelta, "allowed state delta"); for index, path in ipairs(projection.allowedStateDelta) do if typeof(path) ~= "string" then error("invalid allowed state delta") end; delta[index] = tagged("path", path) end end
	return tagged("StudioEvidenceProjection", tagged("id", projection.id) .. tagged("manifest", projection.manifestHash) .. tagged("purpose", projection.purpose) .. projectMaterial(projection.project) .. tagged("binding", bindingHash(projection.binding)) .. tagged("requirements", taggedSequence(requirements)) .. scopeMaterial(projection.scope) .. boundsMaterial(projection.bounds) .. tagged("delta", taggedSequence(delta)))
end
function Generated.projectionHash(projection: any): string return sha256(Generated.projectionMaterial(projection)) end
function Generated.stateDomainMaterial(projection: any): string
	if typeof(projection) ~= "table" then error("invalid evidence projection") end
	sequence(projection.requirements, "projection requirements")
	local requirements = {}; for index, requirement in ipairs(projection.requirements) do requirements[index] = requirementMaterial(requirement) end
	return tagged("StudioStateDomain", projectMaterial(projection.project) .. tagged("requirements", taggedSequence(requirements)) .. scopeMaterial(projection.scope))
end
function Generated.stateDomainHash(projection: any): string return sha256(Generated.stateDomainMaterial(projection)) end
local function diagnosticMaterial(value: any): string
	if typeof(value) ~= "table" or typeof(value.code) ~= "string" or typeof(value.messageHash) ~= "string" then error("invalid diagnostic") end
	return tagged("diagnostic", tagged("code", value.code) .. tagged("hash", value.messageHash))
end
function Generated.envelopeMaterial(envelope: any): string
	if typeof(envelope) ~= "table" then error("invalid evidence envelope") end
	sequence(envelope.facts, "envelope facts"); local facts = {}; for index, fact in ipairs(envelope.facts) do facts[index] = Generated.factMaterial(fact) end
	local diagnostics = {}; if envelope.diagnostics ~= nil then sequence(envelope.diagnostics, "diagnostics"); for index, diagnostic in ipairs(envelope.diagnostics) do diagnostics[index] = diagnosticMaterial(diagnostic) end end
	return tagged("StudioEvidenceEnvelope", tagged("manifest", envelope.manifestHash) .. tagged("projection", envelope.projectionHash) .. tagged("projection-id", envelope.projectionId) .. tagged("binding", envelope.bindingHash) .. projectMaterial(envelope.project) .. tagged("authoritative", envelope.authoritative and "1" or "0") .. tagged("started", envelope.startedAt) .. tagged("ended", envelope.endedAt) .. tagged("completion", envelope.completion) .. tagged("facts", taggedSequence(facts)) .. tagged("diagnostics", taggedSequence(diagnostics)))
end
function Generated.envelopeHash(envelope: any): string return sha256(Generated.envelopeMaterial(envelope)) end
function Generated.projectionRequirements(projection: any): {any}
	Generated.validateProjection(projection)
	return table.clone(projection.requirements)
end
function Generated.validateProjection(projection: any)
	if typeof(projection) ~= "table" or projection.kind ~= "StudioEvidenceProjection" or projection.manifestHash ~= Generated.manifestHash or typeof(projection.requirements) ~= "table" or typeof(projection.bounds) ~= "table" or typeof(projection.scope) ~= "table" then error("invalid generated evidence projection") end
	sequence(projection.requirements, "projection requirements")
	if projection.scope.mode ~= "exact" and projection.scope.mode ~= "project_state" then error("invalid generated evidence projection scope") end
	if typeof(projection.bounds.maximumFacts) ~= "number" or typeof(projection.bounds.maximumBytes) ~= "number" then error("invalid generated evidence bounds") end
	local maximumBytes = projection.scope.mode == "project_state" and Generated.manifest.projectState.maximumEvidenceBytes or Generated.manifest.limits.maximumProjectionBytes
	if #projection.requirements > Generated.manifest.limits.maximumProjectionFacts or projection.bounds.maximumFacts > Generated.manifest.limits.maximumProjectionFacts or projection.bounds.maximumBytes > maximumBytes then error("projection exceeds manifest bounds") end
	local previous = ""; local requirements = projection.requirements :: {any}; for _, requirement: any in ipairs(requirements) do if typeof(requirement.key) ~= "string" or requirement.key <= previous then error("projection requirements must be canonical") end; previous = requirement.key end
	if projection.bindingHash ~= bindingHash(projection.binding) or projection.contentHash ~= Generated.projectionHash(projection) then error("projection hash mismatch") end
end
-- Recompile the exact direct-readback or preflight proof obligations from the
-- sealed CreatorChangeSet. This intentionally accepts no Studio objects and
-- no property policy: every admissible fact comes from Generated.manifest.
-- The template supplies only the approved identity/project/binding/delta fields;
-- requirements, scope, bounds, binding hash, and content hash are rebuilt.
local function nonEmpty(value: any, label: string): string
	if typeof(value) ~= "string" or value == "" then error(label) end
	return value
end
local function studioPath(value: any, label: string): string
	local path = nonEmpty(value, label)
	if string.sub(path, 1, 1) == "/" or string.sub(path, -1) == "/" or string.find(path, "\\", 1, true) then error(label) end
	for _, part in ipairs(string.split(path, "/")) do if part == "" or part == "." or part == ".." then error(label) end end
	return path
end
local function childPath(parentPath: any, name: any): string
	local parent = studioPath(parentPath, "invalid mutation parent path")
	local child = nonEmpty(name, "invalid mutation name")
	if string.find(child, "/", 1, true) then error("invalid mutation name") end
	return parent .. "/" .. child
end
local function sortedNames(value: any, label: string): {string}
	if typeof(value) ~= "table" then error(label) end
	local names = {} :: {string}
	for name in pairs(value) do if typeof(name) ~= "string" then error(label) end; table.insert(names, name) end
	table.sort(names)
	return names
end
local function sortedStrings(value: any, label: string): {string}
	sequence(value, label)
	local copy = {} :: {string}; local seen = {}
	for index, entry in ipairs(value) do
		if typeof(entry) ~= "string" or entry == "" or seen[entry] then error(label) end
		seen[entry] = true; copy[index] = entry
	end
	table.sort(copy)
	return copy
end
local function mutationTarget(stableId: any, path: any, className: any): any
	local target = { kind = "instance", stableId = nonEmpty(stableId, "invalid mutation stable id"), path = studioPath(path, "invalid mutation path"), className = nonEmpty(className, "invalid mutation class") }
	if not Generated.isAllowedRoot(target.path) or Generated.classMetadata(target.className) == nil then error("mutation target outside manifest") end
	return target
end
local function appendMutationRequirements(requirements: {any}, operation: any, target: any, structure: any?, structureStatus: any?)
	local class = Generated.classMetadata(target.className)
	if class == nil then error("mutation class outside manifest") end
	if structureStatus ~= nil then
		local requirement: any = { key = Generated.factKey("structure", target), kind = "structure", target = target, expectedStatus = structureStatus }
		if structureStatus == "observed" then requirement.expected = structure end
		table.insert(requirements, requirement)
	end
	local properties = operation.properties
	if properties ~= nil then
		for _, name in ipairs(sortedNames(properties, "invalid mutation properties")) do
			local property = Generated.propertyMetadata(target.className, name)
			if property == nil then error("mutation property outside manifest") end
			table.insert(requirements, { key = Generated.factKey("property", target, name), kind = "property", target = target, propertyName = name, expected = Generated.validateValue(property.codec, properties[name], property) })
		end
	end
	local attributes = operation.attributes
	if attributes ~= nil then
		local canonicalAttributes = Generated.validateAttributes(attributes)
		for _, name in ipairs(sortedNames(canonicalAttributes, "invalid mutation attributes")) do
			table.insert(requirements, { key = Generated.factKey("attribute", target, name), kind = "attribute", target = target, attributeName = name, expected = canonicalAttributes[name] })
		end
	end
	if operation.removedAttributes ~= nil then
		for _, name in ipairs(sortedStrings(operation.removedAttributes, "invalid removed attributes")) do
			if attributes ~= nil and attributes[name] ~= nil then error("attribute cannot be set and removed") end
			-- Attribute names are validated through the same manifest attribute
			-- route; a harmless boolean checks the name without inventing a table.
			Generated.validateAttributes({ [name] = true })
			table.insert(requirements, { key = Generated.factKey("attribute", target, name), kind = "attribute", target = target, attributeName = name, expectedStatus = "absent" })
		end
	end
	if operation.source ~= nil then
		Generated.validateSource(operation.source, class.source ~= "forbidden")
		table.insert(requirements, { key = Generated.factKey("source_hash", target), kind = "source_hash", target = target, expected = sha256(operation.source) })
	end
end
local function sameInstanceTarget(left: any, right: any): boolean
	return left.kind == "instance" and right.kind == "instance" and left.stableId == right.stableId and left.path == right.path and left.className == right.className
end
local function strictDescendant(path: string, ancestor: string): boolean
	return string.sub(path, 1, #ancestor + 1) == ancestor .. "/"
end
local function targetFromState(value: any): any
	if typeof(value) ~= "table" then error("invalid project-state target") end
	return mutationTarget(value.stableId, value.path, value.className)
end
local function stateFactKey(fact: any, target: any): string
	if fact.kind == "property" then return Generated.factKey("property", target, nonEmpty(fact.propertyName, "invalid state property")) end
	if fact.kind == "attribute" then return Generated.factKey("attribute", target, nonEmpty(fact.attributeName, "invalid state attribute")) end
	if fact.kind == "structure" or fact.kind == "attribute_inventory" or fact.kind == "tags" or fact.kind == "source_hash" or fact.kind == "source_body" or fact.kind == "remote" then return Generated.factKey(fact.kind, target) end
	error("state fact is outside manifest")
end
local function addStateKey(keys: any, key: string)
	keys[key] = true
end
local function stateKeysForTarget(target: any, attributeNames: {string}): any
	local metadata = Generated.classMetadata(target.className)
	if metadata == nil then error("state target outside manifest") end
	local keys = {}; addStateKey(keys, Generated.factKey("structure", target))
	for propertyName in pairs(metadata.properties) do addStateKey(keys, Generated.factKey("property", target, propertyName)) end
	addStateKey(keys, Generated.factKey("attribute_inventory", target))
	for _, name in ipairs(attributeNames) do addStateKey(keys, Generated.factKey("attribute", target, name)) end
	addStateKey(keys, Generated.factKey("tags", target))
	if metadata.source ~= "forbidden" then addStateKey(keys, Generated.factKey("source_hash", target)); addStateKey(keys, Generated.factKey("source_body", target)) end
	if target.className == "RemoteEvent" or target.className == "RemoteFunction" then addStateKey(keys, Generated.factKey("remote", target)) end
	return keys
end
-- This lower-level compiler is hash-free for the provider-free Luau module
-- test. The bound recompiler below hashes its output.
function Generated.compileMutationRequirements(changeSet: any, deleteDescendants: any?): {any}
	if typeof(changeSet) ~= "table" or changeSet.kind ~= "CreatorChangeSet" then error("invalid sealed creator change set") end
	local changeSetId = nonEmpty(changeSet.id, "invalid creator change set id")
	sequence(changeSet.operations, "creator change set operations")
	if #changeSet.operations == 0 or #changeSet.operations > Generated.manifest.limits.maximumOperations then error("creator mutation operation bound") end
	local requirements = {} :: {any}; local operationIds = {}
	for _, operation in ipairs(changeSet.operations) do
		if typeof(operation) ~= "table" then error("invalid creator operation") end
		local operationId = nonEmpty(operation.id, "invalid creator operation id")
		if operationIds[operationId] then error("duplicate creator operation id") end
		operationIds[operationId] = true
		local kind = operation.kind
		if kind == "create" then
			local target = mutationTarget(changeSetId .. ":" .. nonEmpty(operation.tempId, "invalid create temp id"), childPath(operation.parentPath, operation.name), operation.className)
			local metadata = Generated.classMetadata(target.className)
			if metadata == nil or metadata.creatable ~= true then error("create class outside manifest") end
			Generated.validateSource(operation.source, metadata.source ~= "forbidden")
			appendMutationRequirements(requirements, operation, target, { stableId = target.stableId, path = target.path, className = target.className, parentPath = studioPath(operation.parentPath, "invalid mutation parent path") }, "observed")
		elseif kind == "update" then
			appendMutationRequirements(requirements, operation, mutationTarget(operation.stableId, operation.expectedPath, operation.expectedClass))
		elseif kind == "move" then
			local target = mutationTarget(operation.stableId, childPath(operation.parentPath, operation.name), operation.expectedClass)
			appendMutationRequirements(requirements, operation, target, { stableId = target.stableId, path = target.path, className = target.className, parentPath = studioPath(operation.parentPath, "invalid mutation parent path") }, "observed")
		elseif kind == "delete" then
			local root = mutationTarget(operation.stableId, operation.expectedPath, operation.expectedClass)
			appendMutationRequirements(requirements, operation, root, nil, "absent")
			if deleteDescendants ~= nil then
				local descendants = deleteDescendants[operationId]
				if descendants == nil then descendants = {} end
				sequence(descendants, "invalid deleted subtree")
				if #descendants > Generated.manifest.attributes.maximumCount then error("deleted subtree exceeds manifest bound") end
				local seenDescendants = {}
				for _, value in ipairs(descendants) do
					local descendant = targetFromState(value)
					if descendant.stableId == root.stableId or not strictDescendant(descendant.path, root.path) or seenDescendants[descendant.stableId] then error("invalid deleted subtree target") end
					seenDescendants[descendant.stableId] = true
					appendMutationRequirements(requirements, {}, descendant, nil, "absent")
				end
			end
		elseif kind == "write_source" then
			local target = mutationTarget(operation.stableId, operation.expectedPath, operation.expectedClass)
			local metadata = Generated.classMetadata(target.className)
			if metadata == nil or metadata.source == "forbidden" then error("source capability outside manifest") end
			Generated.validateSource(operation.source, true)
			appendMutationRequirements(requirements, operation, target)
		else
			error("creator operation outside manifest")
		end
	end
	table.sort(requirements, function(left, right) return left.key < right.key end)
	local previous = ""; for _, requirement in ipairs(requirements) do if requirement.key <= previous then error("duplicate mutation requirement") end; previous = requirement.key end
	return requirements
end
-- Validate the closed, complete project-state evidence used to derive a
-- mutation's allowed delta. It must enumerate exactly the generated state
-- facts for every inventory instance; a partial snapshot cannot authorize a
-- mutation or a delete subtree.
local function completeProjectStateFacts(projection: any, envelope: any): any
	Generated.validateProjection(projection)
	if projection.scope.mode ~= "project_state" or projection.scope.requireCompleteInventory ~= true then error("complete project-state projection required") end
	if typeof(envelope) ~= "table" or envelope.kind ~= "StudioEvidenceEnvelope" or envelope.manifestHash ~= Generated.manifestHash or envelope.projectionId ~= projection.id or envelope.projectionHash ~= projection.contentHash or envelope.bindingHash ~= projection.bindingHash or envelope.completion ~= "complete" then error("complete project-state evidence required") end
	sequence(envelope.facts, "project-state facts")
	local ordered = Generated.sortFacts(envelope.facts)
	for index, fact in ipairs(ordered) do
		if Generated.factMaterial(fact) ~= Generated.factMaterial(envelope.facts[index]) or typeof(fact.result) ~= "table" or fact.result.status ~= "observed" then error("project-state evidence is not complete and canonical") end
	end
	local factsByKey, structures, inventory = {}, {}, nil
	for _, fact in ipairs(envelope.facts) do
		if factsByKey[fact.key] ~= nil then error("duplicate project-state fact") end
		factsByKey[fact.key] = fact
		if fact.kind == "inventory" then
			if fact.target.kind ~= "project" or fact.key ~= Generated.factKey("inventory", fact.target) or inventory ~= nil then error("invalid project-state inventory") end
			inventory = fact.result.value
		elseif fact.target.kind == "instance" then
			local target = targetFromState(fact.target)
			if fact.key ~= stateFactKey(fact, target) then error("project-state fact key mismatch") end
			if fact.kind == "structure" then
				if structures[target.stableId] ~= nil or typeof(fact.result.value) ~= "table" or fact.result.value.stableId ~= target.stableId or fact.result.value.path ~= target.path or fact.result.value.className ~= target.className then error("invalid project-state structure") end
				structures[target.stableId] = target
			end
		else
			error("project-state fact target outside manifest")
		end
	end
	if inventory == nil then error("project-state evidence omitted inventory") end
	sequence(inventory, "project-state inventory")
	if #inventory > Generated.manifest.projectState.maximumInstances then error("project-state inventory exceeds manifest bound") end
	local inventoryIds = {}
	for _, value in ipairs(inventory) do
		local target = targetFromState(value)
		if inventoryIds[target.stableId] ~= nil or structures[target.stableId] == nil or not sameInstanceTarget(target, structures[target.stableId]) then error("project-state inventory closure failure") end
		inventoryIds[target.stableId] = true
	end
	for stableId, target in pairs(structures) do
		if inventoryIds[stableId] == nil then error("project-state structure omitted from inventory") end
		local attributeInventory = factsByKey[Generated.factKey("attribute_inventory", target)]
		if attributeInventory == nil or attributeInventory.kind ~= "attribute_inventory" then error("project-state attribute inventory missing") end
		local attributeNames = sortedStrings(attributeInventory.result.value, "invalid project-state attribute inventory")
		local expected = stateKeysForTarget(target, attributeNames)
		for key in pairs(expected) do if factsByKey[key] == nil then error("project-state generated fact missing") end end
	end
	for key, fact in pairs(factsByKey) do
		if fact.kind ~= "inventory" then
			local target = targetFromState(fact.target)
			if structures[target.stableId] == nil or not sameInstanceTarget(target, structures[target.stableId]) then error("project-state fact lacks inventory structure") end
			local attributes = factsByKey[Generated.factKey("attribute_inventory", target)]
			local names = sortedStrings(attributes.result.value, "invalid project-state attribute inventory")
			if stateKeysForTarget(target, names)[key] ~= true then error("project-state fact outside generated inventory") end
		end
	end
	return { facts = factsByKey, structures = structures }
end
local function deleteDescendantsFromBefore(changeSet: any, before: any): any
	local descendants = {}
	for _, operation in ipairs(changeSet.operations) do
		if operation.kind == "delete" then
			local root = mutationTarget(operation.stableId, operation.expectedPath, operation.expectedClass)
			local values = {}
			for _, target in pairs(before.structures) do if strictDescendant(target.path, root.path) then table.insert(values, target) end end
			table.sort(values, function(left, right) return left.stableId < right.stableId end)
			if #values > Generated.manifest.attributes.maximumCount then error("deleted subtree exceeds manifest bound") end
			descendants[operation.id] = values
		end
	end
	return descendants
end
-- Derive every potentially observable project-state fact from the sealed
-- operations and complete before-state inventory. This is an allowlist, not
-- an observed delta: reconciliation still proves which listed facts changed.
function Generated.compileMutationAllowedStateDelta(changeSet: any, beforeProjection: any, beforeEnvelope: any): {string}
	-- Reuse the mutation compiler to validate operation names, classes, values,
	-- attributes, paths, and source capability before touching state facts.
	Generated.compileMutationRequirements(changeSet)
	local before = completeProjectStateFacts(beforeProjection, beforeEnvelope)
	local keys = {}
	for _, operation in ipairs(changeSet.operations) do
		local kind = operation.kind
		if kind == "create" then
			local target = mutationTarget(changeSet.id .. ":" .. operation.tempId, childPath(operation.parentPath, operation.name), operation.className)
			for key in pairs(stateKeysForTarget(target, sortedNames(operation.attributes, "invalid mutation attributes"))) do addStateKey(keys, key) end
			addStateKey(keys, Generated.factKey("inventory", { kind = "project" }))
		elseif kind == "update" or kind == "write_source" then
			local target = mutationTarget(operation.stableId, operation.expectedPath, operation.expectedClass)
			if before.structures[target.stableId] == nil or not sameInstanceTarget(target, before.structures[target.stableId]) then error("mutation target missing from complete before state") end
			for _, name in ipairs(sortedNames(operation.properties or {}, "invalid mutation properties")) do addStateKey(keys, Generated.factKey("property", target, name)) end
			local changedAttributes = sortedNames(operation.attributes or {}, "invalid mutation attributes")
			local removed = operation.removedAttributes == nil and {} or sortedStrings(operation.removedAttributes, "invalid removed attributes")
			if #changedAttributes > 0 or #removed > 0 then addStateKey(keys, Generated.factKey("attribute_inventory", target)) end
			for _, name in ipairs(changedAttributes) do addStateKey(keys, Generated.factKey("attribute", target, name)) end
			for _, name in ipairs(removed) do addStateKey(keys, Generated.factKey("attribute", target, name)) end
			if kind == "write_source" then addStateKey(keys, Generated.factKey("source_hash", target)); addStateKey(keys, Generated.factKey("source_body", target)) end
		elseif kind == "delete" then
			local root = mutationTarget(operation.stableId, operation.expectedPath, operation.expectedClass)
			local found = false
			for key, fact in pairs(before.facts) do
				if fact.target.kind == "instance" and (fact.target.path == root.path or strictDescendant(fact.target.path, root.path)) then addStateKey(keys, key); found = true end
			end
			if not found then error("delete target missing from complete before state") end
			addStateKey(keys, Generated.factKey("inventory", { kind = "project" }))
		elseif kind == "move" then
			local oldTarget = mutationTarget(operation.stableId, operation.expectedPath, operation.expectedClass)
			local newPath = childPath(operation.parentPath, operation.name)
			local found = false
			for key, fact in pairs(before.facts) do
				if fact.target.kind == "instance" and (fact.target.path == oldTarget.path or strictDescendant(fact.target.path, oldTarget.path)) then
					local suffix = string.sub(fact.target.path, #oldTarget.path + 1)
					local movedTarget = mutationTarget(fact.target.stableId, newPath .. suffix, fact.target.className)
					addStateKey(keys, key); addStateKey(keys, stateFactKey(fact, movedTarget)); found = true
				end
			end
			if not found then error("move target missing from complete before state") end
			addStateKey(keys, Generated.factKey("inventory", { kind = "project" }))
		else
			error("creator operation outside manifest")
		end
	end
	local output = {} :: {string}; for key in pairs(keys) do table.insert(output, key) end; table.sort(output)
	return output
end
function Generated.recompileMutationProjection(changeSet: any, template: any, beforeProjection: any, beforeEnvelope: any): any
	if typeof(template) ~= "table" or template.kind ~= "StudioEvidenceProjection" then error("invalid mutation projection template") end
	if template.manifestHash ~= Generated.manifestHash or (template.purpose ~= "mutation_direct_readback" and template.purpose ~= "mutation_preflight") then error("invalid mutation projection purpose") end
	local before = completeProjectStateFacts(beforeProjection, beforeEnvelope)
	local delta = Generated.compileMutationAllowedStateDelta(changeSet, beforeProjection, beforeEnvelope)
	local roots = table.clone(Generated.authoringRoots)
	local candidate: any = { kind = "StudioEvidenceProjection", id = nonEmpty(template.id, "invalid mutation projection id"), manifestHash = Generated.manifestHash, purpose = template.purpose, project = template.project, binding = template.binding, bindingHash = "", requirements = Generated.compileMutationRequirements(changeSet, deleteDescendantsFromBefore(changeSet, before)), scope = { mode = "exact", roots = roots, requireCompleteInventory = false }, bounds = { maximumFacts = Generated.manifest.limits.maximumProjectionFacts, maximumBytes = Generated.manifest.limits.maximumProjectionBytes, roots = table.clone(roots) }, allowedStateDelta = delta }
	candidate.bindingHash = bindingHash(candidate.binding)
	candidate.contentHash = Generated.projectionHash(candidate)
	Generated.validateProjection(candidate)
	return candidate
end
-- Rejects a declared proof if *any* recomputed projection byte-equivalent
-- material changed. Transport JSON is separately sealed; content hash covers
-- all semantic projection fields in tagged length-delimited form.
function Generated.assertRecompiledMutationProjection(changeSet: any, declared: any, beforeProjection: any, beforeEnvelope: any): any
	Generated.validateProjection(declared)
	local recompiled = Generated.recompileMutationProjection(changeSet, declared, beforeProjection, beforeEnvelope)
	if recompiled.contentHash ~= declared.contentHash or Generated.projectionMaterial(recompiled) ~= Generated.projectionMaterial(declared) then error("mutation projection recompilation mismatch") end
	return recompiled
end
function Generated.stateRevisionMaterial(manifestHash: string, stateDomainHash: string, facts: any): string
	if manifestHash ~= Generated.manifestHash then error("manifest binding mismatch") end
	local ordered = Generated.sortFacts(facts)
	local materials = {}; for index, fact in ipairs(ordered) do materials[index] = Generated.factMaterial(fact) end
	return tagged("StudioStateRevision", tagged("manifest", manifestHash) .. tagged("state-domain", stateDomainHash) .. tagged("facts", taggedSequence(materials)))
end
function Generated.stateRevisionHash(manifestHash: string, stateDomainHash: string, facts: any): string return sha256(Generated.stateRevisionMaterial(manifestHash, stateDomainHash, facts)) end

return Generated
