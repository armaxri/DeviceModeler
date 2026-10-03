# Package configuration of the Device Modeler build integration: find_package(Devm CONFIG REQUIRED PATHS "<repository>/cmake")
# provides devm_generate() and devm_add_tests(), see DevmGenerate.cmake.
include("${CMAKE_CURRENT_LIST_DIR}/DevmGenerate.cmake")
set(Devm_FOUND TRUE)
