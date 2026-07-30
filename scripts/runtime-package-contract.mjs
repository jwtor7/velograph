const REQUIRED_RUNTIME_DEPENDENCIES = new Map([
  ['better-sqlite3', '12.11.1'],
  ['fflate', '0.8.3'],
]);

export function assertRuntimeDependencyContract(packageManifest) {
  const dependencies = packageManifest?.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('runtime_dependency_boundary_invalid');
  }
  const actualNames = Object.keys(dependencies).sort((left, right) => left.localeCompare(right));
  const expectedNames = [...REQUIRED_RUNTIME_DEPENDENCIES.keys()];
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error('runtime_dependency_boundary_invalid');
  }
  for (const [name, version] of REQUIRED_RUNTIME_DEPENDENCIES) {
    if (dependencies[name] !== version) {
      throw new Error('runtime_dependency_version_invalid');
    }
  }
}
